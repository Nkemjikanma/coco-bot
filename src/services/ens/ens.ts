import { createPublicClient, http, formatEther } from "viem";
import { mainnet } from "viem/chains";
import { readContract } from "viem/actions";
import {
  ENS_CONTRACTS,
  TIME,
  CONTROLLER_ABI,
  BASE_REGISTRAR_ABI,
  ENS_REGISTRY_ABI,
  ENS_SUBGRAPH,
} from "./constants";
import { normalizeENSName, getTokenId, namehash } from "./utils";

import type {
  ENSAvailabilityResult,
  ENSExpiryResult,
  ENSUserPortfolio,
  ENSHistoryResult,
  ENSHistoryEvent,
} from "./types";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;

if (!MAINNET_RPC_URL) {
  throw new Error("MAINNET_RPC_URL environment variable is required");
}

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http(MAINNET_RPC_URL),
});

/**
 * Checks if an ENS domain is available for registration
 */
export async function checkAvailability(
  domainName: string,
): Promise<ENSAvailabilityResult> {
  try {
    // Normalize and validate the domain name
    const { normalized, valid, reason } = normalizeENSName(domainName);
    const fullName = `${normalized}.eth`;

    if (!valid) {
      return {
        label: normalized,
        fullName,
        available: false,
        valid: false,
        reason,
      };
    }

    // Check availability on the controller
    const isAvailable = await readContract(ethereumClient, {
      address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
      abi: CONTROLLER_ABI,
      functionName: "available",
      args: [normalized],
    });

    if (!isAvailable) {
      return {
        label: normalized,
        fullName,
        available: false,
        valid: true,
        reason: "Domain is already registered",
      };
    }

    // Get the price for 1 year registration
    try {
      const priceData = (await readContract(ethereumClient, {
        address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
        abi: CONTROLLER_ABI,
        functionName: "rentPrice",
        args: [normalized, TIME.SECONDS_PER_YEAR],
      })) as { base: bigint; premium: bigint };

      const totalPrice = priceData.base + priceData.premium;
      const priceEth = Number(formatEther(totalPrice)).toFixed(4);

      return {
        label: normalized,
        fullName,
        available: true,
        valid: true,
        priceEth,
      };
    } catch (priceError) {
      // If price fetch fails, still return availability
      console.error("Error fetching price:", priceError);
      return {
        label: normalized,
        fullName,
        available: true,
        valid: true,
        reason: "Available (price unavailable)",
      };
    }
  } catch (error) {
    console.error("Error checking availability:", error);
    return {
      label: "",
      fullName: "",
      available: false,
      valid: false,
      reason: "Error checking availability",
    };
  }
}

/**
 * Checks ENS domain expiration information
 */
export async function checkExpiry(
  domainName: string,
): Promise<ENSExpiryResult> {
  try {
    // Normalize and validate the domain name
    const { normalized, valid, reason } = normalizeENSName(domainName);
    const fullName = `${normalized}.eth`;

    if (!valid) {
      return {
        label: normalized,
        fullName,
        valid: false,
        registered: false,
        reason,
      };
    }

    const tokenId = getTokenId(normalized);
    const nodeHash = namehash(fullName);

    // Check expiry timestamp from BaseRegistrar
    let expiryTimestamp: bigint;
    let registrant: string | undefined;

    try {
      expiryTimestamp = (await readContract(ethereumClient, {
        address: ENS_CONTRACTS.BASE_REGISTRAR,
        abi: BASE_REGISTRAR_ABI,
        functionName: "nameExpires",
        args: [tokenId],
      })) as bigint;

      // If expires is 0, domain is not registered
      if (expiryTimestamp === 0n) {
        return {
          label: normalized,
          fullName,
          valid: true,
          registered: false,
          reason: "Domain is not registered",
        };
      }

      // Get the registrant (NFT holder)
      try {
        registrant = (await readContract(ethereumClient, {
          address: ENS_CONTRACTS.BASE_REGISTRAR,
          abi: BASE_REGISTRAR_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        })) as string;
      } catch {
        // Registrant might not be available if domain expired beyond grace period
        registrant = undefined;
      }
    } catch (error) {
      // Domain not registered or error querying
      return {
        label: normalized,
        fullName,
        valid: true,
        registered: false,
        reason: "Domain is not registered or unavailable",
      };
    }

    // Get the ENS registry owner (who controls the records)
    let owner: string | undefined;
    try {
      owner = (await readContract(ethereumClient, {
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [nodeHash],
      })) as string;
    } catch {
      // Owner might not be set
      owner = undefined;
    }

    // Calculate expiry details
    const now = Math.floor(Date.now() / 1000);
    const expiryTimestampNum = Number(expiryTimestamp);
    const expiryDate = new Date(expiryTimestampNum * 1000);
    const daysUntilExpiry = Math.floor((expiryTimestampNum - now) / 86400);
    const isExpired = now > expiryTimestampNum;

    // Calculate grace period
    const gracePeriodEnds = new Date(
      (expiryTimestampNum + TIME.GRACE_PERIOD_SECONDS) * 1000,
    );
    const inGracePeriod =
      isExpired && now < expiryTimestampNum + TIME.GRACE_PERIOD_SECONDS;

    return {
      label: normalized,
      fullName,
      valid: true,
      registered: true,
      expirationDate: expiryDate,
      daysUntilExpiry,
      expired: isExpired,
      inGracePeriod,
      gracePeriodEnds,
      owner,
      registrant,
    };
  } catch (error) {
    console.error("Error checking expiry:", error);
    return {
      label: "",
      fullName: "",
      valid: false,
      registered: false,
      reason: "Error checking expiry",
    };
  }
}

/**
 * Resolves an ENS domain name to its owner's Ethereum address
 * Supports both .eth domains and subdomains
 */
export async function resolveENSToAddress(
  domainName: string,
): Promise<
  | { success: true; address: string; fullName: string }
  | { success: false; reason: string }
> {
  try {
    // Normalize and validate the domain name
    const { normalized, valid, reason } = normalizeENSName(domainName);

    if (!valid) {
      return {
        success: false,
        reason: reason || "Invalid domain name",
      };
    }

    const fullName = normalized.endsWith(".eth")
      ? normalized
      : `${normalized}.eth`;

    // Check if it's a second-level .eth domain or a subdomain
    const isSecondLevel = !normalized.includes(".");
    const tokenId = getTokenId(normalized);

    if (isSecondLevel) {
      // For .eth domains, get the registrant (NFT owner) from BaseRegistrar
      try {
        const registrant = (await readContract(ethereumClient, {
          address: ENS_CONTRACTS.BASE_REGISTRAR,
          abi: BASE_REGISTRAR_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        })) as string;

        return {
          success: true,
          address: registrant,
          fullName,
        };
      } catch (error) {
        // Domain not registered or expired beyond grace period
        return {
          success: false,
          reason: `${fullName} is not registered or has expired`,
        };
      }
    } else {
      // For subdomains, get the owner from ENS Registry
      try {
        const nodeHash = namehash(fullName);
        const owner = (await readContract(ethereumClient, {
          address: ENS_CONTRACTS.ENS_REGISTRY,
          abi: ENS_REGISTRY_ABI,
          functionName: "owner",
          args: [nodeHash],
        })) as string;

        // Check if owner is zero address (not set)
        if (owner === "0x0000000000000000000000000000000000000000" || !owner) {
          return {
            success: false,
            reason: `${fullName} does not have an owner set`,
          };
        }

        return {
          success: true,
          address: owner,
          fullName,
        };
      } catch (error) {
        return {
          success: false,
          reason: `Unable to resolve ${fullName}`,
        };
      }
    }
  } catch (error) {
    console.error("Error resolving ENS:", error);
    return {
      success: false,
      reason: "Error resolving ENS domain",
    };
  }
}

/**
 * Checks a user's ENS portfolio
 */
export async function getUserPortfolio(
  userAddress: string,
): Promise<ENSUserPortfolio> {
  try {
    // Query subgraph for all user's domains
    const query = `
    query GetUserDomains($owner: String!) {
        account(id: $owner) {

          registrations(first: 1000) {
            domain {
              name
              labelName
            }
            expiryDate
            registrationDate
          }
        }
      }
    `;

    const response = await fetch(ENS_SUBGRAPH.LEGACY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          owner: userAddress.toLowerCase(),
        },
      }),
    });

    const { data } = await response.json();
    if (!data?.account) {
      return {
        address: userAddress,
        totalDomains: 0,
        activeDomains: 0,
        expiredDomains: 0,
        expiringSoon: 0,
        inGracePeriod: 0,
        domains: [],
      };
    }
    const { registrations } = data.account;
    const now = Math.floor(Date.now() / 1000);

    // Process domain data from subgraph (no contract calls for speed)
    const domains: ENSExpiryResult[] = registrations.map((reg: any) => {
      const label = reg.domain.labelName;
      const fullName = reg.domain.name;
      const expiryTimestamp = Number(reg.expiryDate);
      const expiryDate = new Date(expiryTimestamp * 1000);
      const daysUntilExpiry = Math.floor((expiryTimestamp - now) / 86400);
      const isExpired = now > expiryTimestamp;
      const inGracePeriod =
        isExpired && now < expiryTimestamp + TIME.GRACE_PERIOD_SECONDS;
      const gracePeriodEnds = new Date(
        (expiryTimestamp + TIME.GRACE_PERIOD_SECONDS) * 1000,
      );

      return {
        label,
        fullName,
        valid: true,
        registered: true,
        expirationDate: expiryDate,
        daysUntilExpiry,
        expired: isExpired,
        inGracePeriod,
        gracePeriodEnds,
        registrant: userAddress,
      };
    });

    // Calculate stats
    const totalDomains = domains.length;
    const activeDomains = domains.filter((d) => !d.expired).length;
    const expiredDomains = domains.filter((d) => d.expired).length;
    const inGracePeriodCount = domains.filter((d) => d.inGracePeriod).length;
    const expiringSoon = domains.filter(
      (d) =>
        !d.expired &&
        d.daysUntilExpiry !== undefined &&
        d.daysUntilExpiry <= 30,
    ).length;

    // Sort by expiry date (soonest first for active, then expired domains)
    domains.sort((a, b) => {
      // Active domains before expired
      if (a.expired && !b.expired) return 1;
      if (!a.expired && b.expired) return -1;

      // Within same status, sort by expiry date
      return (
        (a.expirationDate?.getTime() || 0) - (b.expirationDate?.getTime() || 0)
      );
    });

    return {
      address: userAddress,
      totalDomains,
      activeDomains,
      expiredDomains,
      expiringSoon,
      inGracePeriod: inGracePeriodCount,
      domains,
    };
  } catch (error) {
    console.error("Error fetching user domains:", error);
    throw error;
  }
}

/**
 * Gets the complete history of an ENS domain
 */
export async function getDomainHistory(
  domainName: string,
): Promise<ENSHistoryResult> {
  try {
    const { normalized, valid, reason } = normalizeENSName(domainName);
    const fullName = `${normalized}.eth`;

    if (!valid) {
      return {
        label: normalized,
        fullName,
        valid: false,
        registered: false,
        reason,
        events: [],
        totalTransfers: 0,
        totalRenewals: 0,
        totalResolverChanges: 0,
      };
    }

    // GraphQL query to get domain history
    const query = `
      query GetDomainHistory($domainName: String!) {
        domains(where: { name: $domainName }) {
          id
          name
          labelName
          createdAt
          expiryDate
          owner {
            id
          }
          registrant {
            id
          }

          registration {
            registrationDate
            expiryDate
            cost
            registrant {
              id
            }

            events(orderBy: blockNumber, orderDirection: asc, first: 100) {
              __typename
              ... on NameRegistered {
                id
                blockNumber
                transactionID
                registrant {
                  id
                }
                expiryDate
              }
              ... on NameRenewed {
                id
                blockNumber
                transactionID
                expiryDate
              }
              ... on NameTransferred {
                id
                blockNumber
                transactionID
                newOwner {
                  id
                }
              }
            }
          }

          events(orderBy: blockNumber, orderDirection: asc, first: 100) {
            __typename
            ... on Transfer {
              id
              blockNumber
              transactionID
              owner {
                id
              }
            }
            ... on NewResolver {
              id
              blockNumber
              transactionID
              resolver {
                address
              }
            }
            ... on NameWrapped {
              id
              blockNumber
              transactionID
              owner {
                id
              }
              fuses
              expiryDate
            }
            ... on NameUnwrapped {
              id
              blockNumber
              transactionID
              owner {
                id
              }
            }
            ... on ExpiryExtended {
              id
              blockNumber
              transactionID
              expiryDate
            }
          }
        }
      }
    `;

    console.log("🔍 Querying subgraph:", ENS_SUBGRAPH.LEGACY);
    console.log("🔍 Query variables:", { domainName: fullName });

    const response = await fetch(ENS_SUBGRAPH.LEGACY, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          domainName: fullName,
        },
      }),
    });

    console.log("📡 Response status:", response.status, response.statusText);
    console.log("📡 Response ok:", response.ok);

    const responseText = await response.text();
    console.log("📦 Raw response:", responseText.substring(0, 500));

    let jsonResponse;
    try {
      jsonResponse = JSON.parse(responseText);
    } catch (e) {
      console.error("❌ Failed to parse JSON response:", e);
      throw new Error("Invalid JSON response from subgraph");
    }

    console.log("📊 Parsed response:", JSON.stringify(jsonResponse, null, 2));

    if (jsonResponse.errors) {
      console.error("❌ GraphQL errors:", jsonResponse.errors);
      throw new Error(
        `GraphQL errors: ${jsonResponse.errors
          .map((e: { message: string }) => e.message)
          .join(", ")}`,
      );
    }

    const { data } = jsonResponse;

    if (!data?.domains || data.domains.length === 0) {
      console.log("⚠️ No domains found in response");
      return {
        label: normalized,
        fullName,
        valid: true,
        registered: false,
        reason: "Domain not found in subgraph",
        events: [],
        totalTransfers: 0,
        totalRenewals: 0,
        totalResolverChanges: 0,
      };
    }

    console.log("✅ Found domain data:", data.domains[0].name);

    const domain = data.domains[0];
    const events: ENSHistoryEvent[] = [];

    // Process registration events
    let totalRenewals = 0;
    let totalTransfers = 0;
    let initialRegistrant: string | undefined;
    let registrationDate: Date | undefined;
    let registrationCost: string | undefined;

    if (domain.registration?.events) {
      for (const event of domain.registration.events) {
        if (event.__typename === "NameRegistered") {
          initialRegistrant = event.registrant.id;
          registrationDate = new Date(
            parseInt(domain.registration.registrationDate) * 1000,
          );
          if (domain.registration.cost) {
            registrationCost = formatEther(BigInt(domain.registration.cost));
          }
          events.push({
            type: "registered",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Registered by ${event.registrant.id.slice(0, 8)}...`,
          });
        } else if (event.__typename === "NameRenewed") {
          totalRenewals++;
          const newExpiry = new Date(parseInt(event.expiryDate) * 1000);
          events.push({
            type: "renewed",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Renewed until ${newExpiry.toLocaleDateString()}`,
          });
        } else if (event.__typename === "NameTransferred") {
          totalTransfers++;
          events.push({
            type: "transferred",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Transferred to ${event.newOwner.id.slice(0, 8)}...`,
          });
        }
      }
    }

    // Process domain events
    let totalResolverChanges = 0;
    if (domain.events) {
      for (const event of domain.events) {
        if (event.__typename === "Transfer") {
          // Skip if already counted in registration events
          const alreadyCounted = events.some(
            (e) =>
              e.transactionHash === event.transactionID &&
              e.type === "transferred",
          );
          if (!alreadyCounted) {
            totalTransfers++;
            events.push({
              type: "transferred",
              blockNumber: event.blockNumber,
              transactionHash: event.transactionID,
              details: `Controller transferred to ${event.owner.id.slice(
                0,
                8,
              )}...`,
            });
          }
        } else if (event.__typename === "NewResolver") {
          totalResolverChanges++;
          events.push({
            type: "resolver_changed",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Resolver set to ${event.resolver.address.slice(0, 8)}...`,
          });
        } else if (event.__typename === "NameWrapped") {
          events.push({
            type: "wrapped",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Wrapped by ${event.owner.id.slice(0, 8)}...`,
          });
        } else if (event.__typename === "NameUnwrapped") {
          events.push({
            type: "unwrapped",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Unwrapped by ${event.owner.id.slice(0, 8)}...`,
          });
        } else if (event.__typename === "ExpiryExtended") {
          const newExpiry = new Date(parseInt(event.expiryDate) * 1000);
          events.push({
            type: "expiry_extended",
            blockNumber: event.blockNumber,
            transactionHash: event.transactionID,
            details: `Expiry extended to ${newExpiry.toLocaleDateString()}`,
          });
        }
      }
    }

    // Sort events by block number
    events.sort((a, b) => a.blockNumber - b.blockNumber);

    return {
      label: normalized,
      fullName,
      valid: true,
      registered: true,
      currentOwner: domain.owner?.id,
      currentRegistrant: domain.registrant?.id,
      expiryDate: domain.expiryDate
        ? new Date(parseInt(domain.expiryDate) * 1000)
        : undefined,
      createdAt: domain.createdAt
        ? new Date(parseInt(domain.createdAt) * 1000)
        : undefined,
      registrationDate,
      registrationCost,
      initialRegistrant,
      events,
      totalTransfers,
      totalRenewals,
      totalResolverChanges,
    };
  } catch (error) {
    console.error("Error fetching domain history:", error);
    throw error;
  }
}
