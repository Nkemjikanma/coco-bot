export interface TransferTransactionData {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  chainId: number;
}

export type TransferContract = "registry" | "nameWrapper" | "registrar";

export interface TransferParams {
  name: string;
  newOwnerAddress: `0x${string}`;
  currentOwner: `0x${string}`;
  contract: TransferContract;
  reclaim?: boolean;
  asParent?: boolean;
}
