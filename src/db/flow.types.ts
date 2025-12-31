export type FlowType = "registration" | "bridge" | "subdomain";

export type FlowStatus =
  | "initiated" // Flow started, waiting for first action
  | "awaiting_wallet" // Waiting for wallet selection
  | "awaiting_bridge" // Waiting for bridge transaction
  | "step1_pending" // Step 1 transaction sent, waiting for confirmation
  | "step1_complete" // Step 1 done, preparing step 2
  | "step2_pending" // Step 2 transaction sent, waiting for confirmation
  | "complete" // All done
  | "failed"; // Something went wrong

export type ActiveFlow = RegistrationFlow | BridgeFlow | SubdomainFlow;

export interface RegistrationFlowData {
  // Names being registered
  names: Array<{
    name: string;
    secret: `0x${string}`;
    commitment: `0x${string}`;
    owner: `0x${string}`;
    durationSec: bigint;
    domainPriceWei: bigint;
  }>;

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
  // Subdomain info
  subdomain: string; // e.g., "treasury"
  domain: string; // e.g., "cocobot.eth"
  fullName: string; // e.g., "treasury.cocobot.eth"

  // Addresses
  recipient: `0x${string}`;
  ownerWallet: `0x${string}`;

  // Parent domain info
  isWrapped: boolean;

  // Transaction tracking
  step1TxHash?: string;
  step2TxHash?: string;

  // Whether step 2 is possible (recipient is user's wallet)
  canDoStep2: boolean;
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
