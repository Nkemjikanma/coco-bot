/**
 * Parse a full subname into its components
 * e.g., "blog.alice.eth" -> { label: "blog", parent: "alice.eth", ... }
 */

import { namehash } from "@ensdomains/ensjs/utils";
import { ParsedSubname } from "./subdomain.types";

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
    labelHash: namehash(label) as `0x${string}`,
  };
}

/**
 * Check if a name is a subname (3+ parts)
 */
export function isSubname(name: string): boolean {
  return name.split(".").length >= 3;
}
