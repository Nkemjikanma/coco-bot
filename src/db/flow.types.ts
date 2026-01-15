export type FlowType =
  | "registration"
  | "bridge"
  | "subdomain"
  | "transfer"
  | "renew";

export type FlowStatus =
  | "initiated" // Flow started, waiting for first action
  | "awaiting_wallet" // Waiting for wallet selection
  | "awaiting_bridge" // Waiting for bridge transaction
  | "step1_pending" // Step 1 transaction sent, waiting for confirmation
  | "step1_complete" // Step 1 done, preparing step 2
  | "step2_pending" // Step 2 transaction sent, waiting for confirmation
  | "step2_complete"
  | "step3_pending" //Step 3, transafer subdomain
  | "complete" // All done
  | "failed" // Something went wrong
  | "awaiting_confirmation"
  // Renew specific
  | "renew_failed"
  | "renew_pending";

export type ActiveFlow =
  | RegistrationFlow
  | BridgeFlow
  | SubdomainFlow
  | TransferFlow
  | RenewFlow;

export interface RegistrationFlowData {
  // Name being registered
  name: string;

  commitment?: {
    name: string;
    secret: `0x${string}`;
    commitment: `0x${string}`;
    owner: `0x${string}`;
    durationSec: bigint;
    domainPriceWei: bigint;
  };

  // Cost estimates
  costs: {
    commitGasWei: bigint;
    commitGasEth: string;
    registerGasWei: bigint;
    registerGasEth: string;
    isRegisterEstimate: boolean;
  };
  totalDomainCostWei: bigint;
  totalDomainCostEth: string;
  grandTotalWei: bigint;
  grandTotalEth: string;

  // Wallet info
  selectedWallet?: `0x${string}`;
  walletCheckResult?: {
    wallets: Array<{
      address: `0x${string}`;
      l1Balance: bigint;
      l1BalanceEth: string;
      l2Balance: bigint;
      l2BalanceEth: string;
      totalBalance: bigint;
      totalBalanceEth: string;
    }>;
    hasWalletWithSufficientL1: boolean;
    hasWalletWithSufficientL2ForBridge: boolean;
    bestWalletForL1: any;
    bestWalletForBridge: any;
  };

  // Transaction tracking
  commitTxHash?: `0x${string}`;
  commitTimestamp?: number;
  registerTxHash?: `0x${string}`;
}

export interface BridgeFlowData {
  // Bridge details
  sourceChain: number;
  destChain: number;
  amountWei: bigint;
  amountEth: string;

  // Quote info
  quote?: {
    estimatedOutput: bigint;
    estimatedOutputEth: string;
    fee: bigint;
    feeEth: string;
    route: string;
  };

  // Wallet
  userWallet: `0x${string}`;

  // Transaction tracking
  bridgeTxHash?: `0x${string}`;
  bridgeTimestamp?: number;

  // What to do after bridge completes
  nextAction?: "continue_registration" | "wait_for_bridge_completion" | "none";
  registrationData?: RegistrationFlowData;
}

export interface SubdomainFlowData {
  // Core subdomain info
  subdomain: string; // The label (e.g., "treasury")
  domain: string; // The parent (e.g., "myname.eth")
  fullName: string; // The full name (e.g., "treasury.myname.eth")

  // Addresses
  resolveAddress: string; // Address the subdomain should point to (NEW!)
  recipient: string; // Final owner of the subdomain
  ownerWallet: string; // User's wallet that signs all transactions

  // Domain state
  isWrapped: boolean; // Whether parent is wrapped

  // Flow progress (NEW!)
  currentStep: number; // Current step (1, 2, or 3)
  totalSteps: number; // Total steps (2 if recipient=caller, 3 otherwise)

  // Transaction hashes
  step1TxHash?: string; // Create subdomain tx
  step2TxHash?: string; // Set address record tx
  step3TxHash?: string; // Transfer ownership tx (NEW!)

  // Legacy field (keep for backward compatibility)
  canDoStep2?: boolean;
}

export interface TransferFlowData {
  // Core transfer info
  domain: string;
  recipient: `0x${string}`;
  ownerWallet: `0x${string}`;
  isWrapped: boolean;

  // Transaction tracking (optional, populated after tx sent)
  txHash?: `0x${string}`;

  // Contract that will be used (helpful for debugging/display)
  contract?: "registry" | "nameWrapper" | "registrar";
}

export interface RenewFlowData {
  name: string;
  labelName: string; // Without .eth
  durationYears: number;
  durationSeconds: bigint;
  totalCostWei: bigint;
  totalCostEth: string;
  recommendedValueWei: bigint;
  recommendedValueEth: string;
  currentExpiry: Date | string;
  newExpiry: Date | string;
  ownerWallet: `0x${string}`;
  isWrapped: boolean;
  txHash?: `0x${string}`;
}

// ============ Base Flow Interface ============
interface BaseFlow {
  // Identity
  userId: string;
  threadId: string;
  channelId: string;

  // Flow info
  type: FlowType;
  status: FlowStatus;

  // Timestamps
  startedAt: number;
  updatedAt: number;
}

// ============ Specific Flow Types ============
export interface RegistrationFlow extends BaseFlow {
  type: "registration";
  data: RegistrationFlowData;
}

export interface BridgeFlow extends BaseFlow {
  type: "bridge";
  data: BridgeFlowData;
}

export interface SubdomainFlow extends BaseFlow {
  type: "subdomain";
  data: SubdomainFlowData;
}

export interface TransferFlow extends BaseFlow {
  type: "transfer";
  data: TransferFlowData;
}

export interface RenewFlow extends BaseFlow {
  type: "renew";
  data: RenewFlowData;
}
