export interface CreateSubnameParams {
  /** The full subname to create (e.g., "blog.alice.eth") */
  name: string;
  /** The new owner address for the subname */
  owner: `0x${string}`;
  /** The contract to use: "registry" for unwrapped, "nameWrapper" for wrapped names */
  contract: "registry" | "nameWrapper";
  /** Resolver address (optional, defaults to public resolver) */
  resolverAddress?: `0x${string}`;
  /** For wrapped names: expiry timestamp (optional) */
  expiry?: bigint;
  /** For wrapped names: fuses to burn (optional) */
  fuses?: number;
}

export interface SubnameTransactionData {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  chainId: number;
}

export interface ParsedSubname {
  label: string; // e.g., "blog"
  parent: string; // e.g., "alice.eth"
  full: string; // e.g., "blog.alice.eth"
  parentNode: `0x${string}`; // namehash of parent
  labelHash: `0x${string}`; // labelhash of the label
}
