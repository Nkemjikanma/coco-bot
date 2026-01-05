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

// ============================================================
// SUBDOMAIN FLOW DATA (for 3-step flow)
// ============================================================

/**
 * Data stored in the flow for subdomain creation
 * Used by the 3-step flow: Create → Set Address → Transfer
 */
export interface SubdomainFlowData {
  // Core subdomain info
  subdomain: string; // The label (e.g., "treasury")
  domain: string; // The parent (e.g., "myname.eth")
  fullName: string; // The full name (e.g., "treasury.myname.eth")

  // Addresses
  resolveAddress: string; // Address the subdomain should point to
  recipient: string; // Final owner of the subdomain
  ownerWallet: string; // User's wallet that signs all transactions

  // Domain state
  isWrapped: boolean; // Whether parent is wrapped

  // Flow progress
  currentStep: number; // Current step (1, 2, or 3)
  totalSteps: number; // Total steps (2 if recipient=caller, 3 otherwise)

  // Transaction hashes (populated as flow progresses)
  step1TxHash?: string; // Create subdomain tx
  step2TxHash?: string; // Set address record tx
  step3TxHash?: string; // Transfer ownership tx

  // Legacy field (for backward compatibility)
  canDoStep2?: boolean;
}

/**
 * Flow statuses for subdomain flow
 */
export type SubdomainFlowStatus =
  | "step1_pending" // Waiting for step 1 tx
  | "step1_complete" // Step 1 done
  | "step2_pending" // Waiting for step 2 tx
  | "step2_complete" // Step 2 done
  | "step3_pending" // Waiting for step 3 tx
  | "complete" // All done
  | "failed"; // Something went wrong
