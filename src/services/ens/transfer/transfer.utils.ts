import { labelhash, namehash } from "viem";

/**
 * Get name type based on structure
 */
export function getNameType(name: string): "eth-2ld" | "eth-subname" | "other" {
  const labels = name.split(".");

  if (!name.endsWith(".eth")) {
    return "other";
  }

  if (labels.length === 2) {
    return "eth-2ld"; // e.g., alice.eth
  }

  return "eth-subname"; // e.g., blog.alice.eth
}

/**
 * Parse name into label, labelhash, and parent node
 */
export function makeLabelNodeAndParent(name: string): {
  label: string;
  labelHash: `0x${string}`;
  parentNode: `0x${string}`;
} {
  const labels = name.split(".");
  const label = labels[0];
  const parent = labels.slice(1).join(".");

  return {
    label,
    labelHash: labelhash(label) as `0x${string}`,
    parentNode: namehash(parent) as `0x${string}`,
  };
}
