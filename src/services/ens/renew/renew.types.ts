export interface RenewalCostEstimate {
  name: string;
  durationYears: number;
  durationSeconds: bigint;
  basePrice: bigint;
  premium: bigint;
  totalCostWei: bigint;
  totalCostEth: string;
  // Include buffer for gas price fluctuations
  recommendedValueWei: bigint;
  recommendedValueEth: string;
}

export interface RenewalPreparation {
  name: string;
  labelName: string; // Without .eth
  durationYears: number;
  durationSeconds: bigint;
  totalCostWei: bigint;
  totalCostEth: string;
  recommendedValueWei: bigint;
  recommendedValueEth: string;
  currentExpiry: Date;
  newExpiry: Date;
  ownerWallet: `0x${string}`;
  isWrapped: boolean;
}

export interface RenewalTransaction {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  valueHex: string;
}
