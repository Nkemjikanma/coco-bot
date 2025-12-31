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

export interface SubdomainPrepareResult {
  success: boolean;
  reason?: string;
  subdomain?: string;
  domain?: string;
  fullName?: string;
  parentNode?: `0x${string}`;
  subdomainNode?: `0x${string}`;
  labelHash?: `0x${string}`;
  recipient?: `0x${string}`;
  ownerWallet?: `0x${string}`;
  isWrapped?: boolean;
}

export interface SubdomainAssignmentState {
  userId: string;
  channelId: string;
  threadId: string;
  subdomain: string;
  domain: string;
  fullName: string;
  recipient: `0x${string}`;
  ownerWallet: `0x${string}`;
  isWrapped: boolean;
  timestamp: number;
  status: "pending" | "step1_complete" | "completed" | "failed";
  step1TxHash?: string;
  step2TxHash?: string;
  canDoStep2: boolean;
}
