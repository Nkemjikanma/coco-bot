/**
 * Parse a full subname into its components
 * e.g., "blog.alice.eth" -> { label: "blog", parent: "alice.eth", ... }
 */

import { namehash } from "@ensdomains/ensjs/utils";
import { ParsedSubname } from "./subdomain.types";
import { labelhash } from "viem";
import { CompleteSubdomainInfo, SubdomainInfo } from "../../../types";

export function parseSubname(fullName: string): ParsedSubname | null {
  const parts = fullName.split(".");

  if (parts.length < 3) {
    return null;
  }

  const label = parts[0];
  const parent = parts.slice(1).join(".");

  return {
    label,
    parent,
    full: fullName,
    parentNode: namehash(parent) as `0x${string}`,
    labelHash: labelhash(label) as `0x${string}`,
  };
}

/**
 * Check if a name is a subname (3+ parts)
 */
export function isSubname(name: string): boolean {
  return name.split(".").length >= 3;
}

/**
 * Validate subdomain and domain labels
 */
export function validateSubdomainParts(
  subdomain: string,
  domain: string,
): { valid: boolean; reason?: string } {
  // Check subdomain label
  if (subdomain.length === 0) {
    return { valid: false, reason: "Subdomain label cannot be empty" };
  }

  if (subdomain.length > 63) {
    return {
      valid: false,
      reason: "Subdomain label cannot exceed 63 characters",
    };
  }

  // Check for valid characters (alphanumeric and hyphens, no leading/trailing hyphens)
  const labelRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
  if (!labelRegex.test(subdomain)) {
    return {
      valid: false,
      reason:
        "Subdomain can only contain letters, numbers, and hyphens (not at start/end)",
    };
  }

  // Check domain label
  if (domain.length === 0) {
    return { valid: false, reason: "Domain label cannot be empty" };
  }

  return { valid: true };
}

/**
 * Check if an address is a valid EOA address
 */
export function isValidEOAAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isCompleteSubdomainInfo(
  info: SubdomainInfo | undefined,
): info is CompleteSubdomainInfo {
  return !!(info?.parent && info?.label && info?.resolveAddress && info?.owner);
}
