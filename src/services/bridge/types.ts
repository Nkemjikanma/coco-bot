// Bridge-related TypeScript types

export interface BridgeState {
  userId: string;
  channelId: string;
  domain: string;
  label: string;
  years: number;
  fromChain: number;
  toChain: number;
  amount: bigint;
  recipient: `0x${string}`;
  depositId?: string;
  depositTxHash?: string;
  fillTxHash?: string;
  timestamp: number;
  status: "pending" | "bridging" | "completed" | "failed";
}

export interface BridgeQuote {
  estimatedFillTimeSec: number;
  totalRelayFee: {
    pct: string;
    total: string;
  };
  estimatedTime: string;
  limits: {
    minDeposit: string;
    maxDeposit: string;
    maxDepositInstant: string;
    maxDepositShortDelay: string;
  };
  isAmountTooLow: boolean;
  spokePoolAddress: string;
}

export interface BalanceCheckResult {
  address: `0x${string}`;
  chainId: number;
  balance: bigint;
  balanceEth: string;
  sufficient: boolean;
  required?: bigint;
  shortfall?: bigint;
}

export interface BridgeDepositEvent {
  depositId: string;
  depositor: string;
  recipient: string;
  inputToken: string;
  inputAmount: string;
  outputToken: string;
  outputAmount: string;
  destinationChainId: number;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  message: string;
}

export interface BridgeStatusResponse {
  status: "pending" | "filled" | "expired";
  fillTx?: string;
  fillTimestamp?: number;
}
