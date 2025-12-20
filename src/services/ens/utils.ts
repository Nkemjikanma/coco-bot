import { keccak256, toHex, concat, toBytes } from "viem";
import { normalize } from "viem/ens";
import { ENS_VALIDATION } from "./constants";
import { GetNameHistoryReturnType } from "@ensdomains/ensjs/subgraph";
import {
  HistoryData,
  ENSHistoryEvent,
  PortfolioData,
  ENSPortfolioName,
} from "../../api";
import type {
  GetNamesForAddressReturnType,
  NameWithRelation,
} from "@ensdomains/ensjs/subgraph";
import type { Address } from "viem";
/**
 * Normalizes and validates an ENS domain name
 */
export function normalizeENSName(domainName: string): {
  normalized: string;
  valid: boolean;
  reason?: string;
} {
  try {
    // Remove .eth suffix if present
    const label = domainName
      .toLowerCase()
      .trim()
      .replace(ENS_VALIDATION.SUFFIX, "");

    // Normalize (handles Unicode)
    const normalized = normalize(label);

    // Validate length
    if (normalized.length < ENS_VALIDATION.MIN_LENGTH) {
      return {
        normalized,
        valid: false,
        reason: `Name must be at least ${ENS_VALIDATION.MIN_LENGTH} characters`,
      };
    }

    return { normalized, valid: true };
  } catch (error) {
    return {
      normalized: "",
      valid: false,
      reason: "Invalid ENS name format",
    };
  }
}

/**
 * Converts an ENS label to its tokenId (labelhash)
 * Used by BaseRegistrar contract
 */
export function getTokenId(label: string): bigint {
  const hash = keccak256(toHex(label));
  return BigInt(hash);
}

/**
 * Computes ENS namehash for a full domain name
 * Used by ENS Registry contract
 */
export function namehash(name: string): `0x${string}` {
  // For .eth domains: namehash(eth) + keccak256(label)
  const ethNode =
    "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";
  const label = name.toLowerCase().replace(".eth", "");
  const labelHash = keccak256(toBytes(label));

  return keccak256(concat([toBytes(ethNode), toBytes(labelHash)]));
}

/**
 * Formats ETH price to 4 decimal places
 */
export function formatPrice(priceEth: string): string {
  return Number(priceEth).toFixed(4);
}

/**
 * Calculates days until a future date
 */
export function daysUntil(date: Date): number {
  const now = new Date();
  return Math.floor((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Shortens an Ethereum address for display
 * Example: 0x1234567890abcdef... -> 0x1234...cdef
 */
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// format response from ensjs to match our api response
export function mapEnsHistoryResponse(
  data: GetNameHistoryReturnType,
): HistoryData {
  if (!data) {
    return { events: [] };
  }

  const events: ENSHistoryEvent[] = [];

  // Map domain events
  for (const event of data.domainEvents) {
    switch (event.type) {
      case "Transfer":
        events.push({
          type: "transferred",
          blockNumber: event.blockNumber,
          transactionHash: event.transactionID,
          to: event.owner,
        });
        break;

      case "NameWrapped":
        events.push({
          type: "wrapped",
          blockNumber: event.blockNumber,
          transactionHash: event.transactionID,
          owner: event.owner,
          expiryDate: event.expiryDate,
        });
        break;

      case "NameUnwrapped":
        events.push({
          type: "unwrapped",
          blockNumber: event.blockNumber,
          transactionHash: event.transactionID,
          owner: event.owner,
        });
        break;

      case "ExpiryExtended":
        events.push({
          type: "expiry_extended",
          blockNumber: event.blockNumber,
          transactionHash: event.transactionID,
          expiryDate: event.expiryDate,
        });
        break;

      // Skip technical events: NewOwner, NewResolver, NewTTL, WrappedTransfer, FusesSet
      default:
        break;
    }
  }

  // Map registration events
  if (data.registrationEvents) {
    for (const event of data.registrationEvents) {
      switch (event.type) {
        case "NameRegistered":
          events.push({
            type: "registered",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            to: event.registrant,
            expiryDate: event.expiryDate,
          });
          break;

        case "NameRenewed":
          events.push({
            type: "renewed",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            expiryDate: event.expiryDate,
          });
          break;

        case "NameTransferred":
          events.push({
            type: "transferred",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            to: event.newOwner,
          });
          break;
      }
    }
  }

  // Sort by block number (chronological)
  events.sort((a, b) => a.blockNumber - b.blockNumber);

  return { events };
}

export function mapNamesForAddressToPortfolioData(
  namesFromSubgraph: GetNamesForAddressReturnType,
  primaryName?: string | null,
): PortfolioData {
  const normalizedPrimary = primaryName?.toLowerCase() ?? null;

  const names: ENSPortfolioName[] = namesFromSubgraph
    // If ENSJS can return null names, drop them
    .filter(
      (n): n is NameWithRelation & { name: string } =>
        typeof n.name === "string" && n.name.length > 0,
    )
    .map((n) => {
      const expiry = dateWithValueToDate(n.expiryDate);
      const { expiryDate, isExpired } = computeExpiry(expiry);

      const isPrimary =
        normalizedPrimary != null && n.name.toLowerCase() === normalizedPrimary;

      return {
        name: n.name,
        expiryDate,
        isExpired,
        isPrimary,
      };
    });

  // Optional: sort so primary is first, then by expiry asc, then name
  names.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    const tA =
      (a.expiryDate as Date).getTime?.() ??
      new Date(a.expiryDate as any).getTime();
    const tB =
      (b.expiryDate as Date).getTime?.() ??
      new Date(b.expiryDate as any).getTime();
    if (tA !== tB) return tA - tB;
    return a.name.localeCompare(b.name);
  });

  return {
    names,
    totalCount: names.length,
    primaryName: primaryName ?? null,
  };
}

export function formatExpiryDate(expiryDate: string): string {
  try {
    const timestamp = BigInt(expiryDate);
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown";
  }
}
function dateWithValueToDate(
  d: { value: number; date?: Date } | null | undefined,
): Date | null {
  if (!d) return null;
  if (d.date instanceof Date) return d.date;
  // value is typically seconds since epoch in ENS subgraph types
  return new Date(d.value * 1000);
}

function computeExpiry(expiryDate: Date | null): {
  expiryDate: Date;
  isExpired: boolean;
} {
  const safeExpiry = expiryDate ?? new Date(0); // epoch as a sentinel (treat as expired)
  const now = Date.now();
  const isExpired = safeExpiry.getTime() <= now;
  return { expiryDate: safeExpiry, isExpired };
}
