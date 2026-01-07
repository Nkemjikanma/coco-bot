import {
  createPublicClient,
  encodeFunctionData,
  http,
  labelhash,
  namehash,
  type PublicClient,
} from "viem";
import { base, mainnet } from "viem/chains";
import { ENS_CONTRACTS, NAME_WRAPPER_ADDRESS } from "../constants";
import { getActualOwner, verifyOwnership } from "../utils";
import {
  BASE_REGISTRAR_RECLAIM_ABI,
  BASE_REGISTRAR_SAFE_TRANSFER_ABI,
  NAME_WRAPPER_SAFE_TRANSFER_ABI,
  NAME_WRAPPER_SET_SUBNODE_OWNER_ABI,
  REGISTRY_SET_OWNER_ABI,
  REGISTRY_SET_SUBNODE_OWNER_ABI,
} from "./transfer.constants";
import type {
  TransferContract,
  TransferTransactionData,
} from "./transfer.types";
import { getNameType, makeLabelNodeAndParent } from "./transfer.utils";

export class TransferService {
  private publicClient: PublicClient;
  private chainId: number;

  constructor(rpcURL: string, chainId: number = 1) {
    this.chainId = chainId;
    this.publicClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcURL),
    });
  }

  /**
   * Get the ACTUAL owner of a name (handles wrapped names)
   */
  async getNameOwner(name: string): Promise<{
    owner: `0x${string}` | null;
    isWrapped: boolean;
    error?: string;
  }> {
    return await getActualOwner(name);
  }

  /**
   * Check if caller can transfer the name
   */
  async canTransferName(
    name: string,
    callerAddress: `0x${string}`,
  ): Promise<{ canTransfer: boolean; reason?: string }> {
    const ownerResult = await this.getNameOwner(name);

    if (!ownerResult.owner) {
      return {
        canTransfer: false,
        reason: ownerResult.error || `${name} is not registered`,
      };
    }

    if (ownerResult.owner.toLowerCase() !== callerAddress.toLowerCase()) {
      return {
        canTransfer: false,
        reason: `You don't own ${name}. The owner is ${ownerResult.owner}`,
      };
    }

    return { canTransfer: true };
  }

  /**
   * Verify that one of the user's wallets owns the name
   */
  async verifyParentOwnership(
    name: string,
    userWallets: `0x${string}`[],
  ): Promise<{
    owned: boolean;
    ownerWallet?: `0x${string}`;
    isWrapped: boolean;
    actualOwner?: `0x${string}`;
    error?: string;
  }> {
    console.log(`\n========== verifyOwnership (Transfer) ==========`);
    console.log(`Name: ${name}`);
    console.log(`User wallets: ${userWallets.join(", ")}`);
    console.log(`NameWrapper address: ${NAME_WRAPPER_ADDRESS}`);
    console.log(`================================================\n`);

    const result = await verifyOwnership(name, userWallets);

    console.log(`[verifyOwnership] Result:`, result);

    return result;
  }

  /**
   * Determine which contract to use for the transfer
   */
  getTransferContract(name: string, isWrapped: boolean): TransferContract {
    const nameType = getNameType(name);

    if (isWrapped) {
      return "nameWrapper";
    }

    // For unwrapped 2LD names, use registrar
    if (nameType === "eth-2ld") {
      return "registrar";
    }

    // For unwrapped subnames, use registry
    return "registry";
  }

  /**
   * Build transfer transaction for Registry contract
   */
  private buildRegistryTransfer(params: {
    name: string;
    newOwnerAddress: `0x${string}`;
    asParent?: boolean;
  }): TransferTransactionData {
    const { name, newOwnerAddress, asParent } = params;

    if (asParent) {
      // Transfer as parent owner (setSubnodeOwner)
      const { labelHash, parentNode } = makeLabelNodeAndParent(name);

      const data = encodeFunctionData({
        abi: REGISTRY_SET_SUBNODE_OWNER_ABI,
        functionName: "setSubnodeOwner",
        args: [parentNode, labelHash, newOwnerAddress],
      });

      return {
        to: ENS_CONTRACTS.ENS_REGISTRY,
        data,
        value: 0n,
        chainId: this.chainId,
      };
    }

    // Transfer as owner (setOwner)
    const node = namehash(name) as `0x${string}`;

    const data = encodeFunctionData({
      abi: REGISTRY_SET_OWNER_ABI,
      functionName: "setOwner",
      args: [node, newOwnerAddress],
    });

    return {
      to: ENS_CONTRACTS.ENS_REGISTRY,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * Build transfer transaction for BaseRegistrar contract (2LD .eth names only)
   */
  private buildRegistrarTransfer(params: {
    name: string;
    newOwnerAddress: `0x${string}`;
    currentOwner: `0x${string}`;
    reclaim?: boolean;
  }): TransferTransactionData {
    const { name, newOwnerAddress, currentOwner, reclaim } = params;
    const labels = name.split(".");
    const label = labels[0];
    const tokenId = BigInt(labelhash(label));

    if (reclaim) {
      // Reclaim: Sets the owner in the ENS registry
      const data = encodeFunctionData({
        abi: BASE_REGISTRAR_RECLAIM_ABI,
        functionName: "reclaim",
        args: [tokenId, newOwnerAddress],
      });

      return {
        to: ENS_CONTRACTS.BASE_REGISTRAR,
        data,
        value: 0n,
        chainId: this.chainId,
      };
    }

    // SafeTransferFrom: Transfers the NFT
    const data = encodeFunctionData({
      abi: BASE_REGISTRAR_SAFE_TRANSFER_ABI,
      functionName: "safeTransferFrom",
      args: [currentOwner, newOwnerAddress, tokenId],
    });

    return {
      to: ENS_CONTRACTS.BASE_REGISTRAR,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * Build transfer transaction for NameWrapper contract (wrapped names)
   */
  private buildNameWrapperTransfer(params: {
    name: string;
    newOwnerAddress: `0x${string}`;
    currentOwner: `0x${string}`;
    asParent?: boolean;
  }): TransferTransactionData {
    const { name, newOwnerAddress, currentOwner, asParent } = params;

    if (asParent) {
      // Transfer as parent owner (setSubnodeOwner)
      const { label, parentNode } = makeLabelNodeAndParent(name);

      const data = encodeFunctionData({
        abi: NAME_WRAPPER_SET_SUBNODE_OWNER_ABI,
        functionName: "setSubnodeOwner",
        args: [parentNode, label, newOwnerAddress, 0, 0n],
      });

      return {
        to: NAME_WRAPPER_ADDRESS,
        data,
        value: 0n,
        chainId: this.chainId,
      };
    }

    // SafeTransferFrom: Transfers the wrapped NFT
    const node = namehash(name);
    const tokenId = BigInt(node);

    const data = encodeFunctionData({
      abi: NAME_WRAPPER_SAFE_TRANSFER_ABI,
      functionName: "safeTransferFrom",
      args: [currentOwner, newOwnerAddress, tokenId, 1n, "0x"],
    });

    return {
      to: NAME_WRAPPER_ADDRESS,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * Build transfer transaction based on name type and wrapped status
   */
  buildTransferTransaction(params: {
    name: string;
    newOwnerAddress: `0x${string}`;
    currentOwner: `0x${string}`;
    isWrapped: boolean;
    reclaim?: boolean;
    asParent?: boolean;
  }): TransferTransactionData {
    const {
      name,
      newOwnerAddress,
      currentOwner,
      isWrapped,
      reclaim,
      asParent,
    } = params;
    const nameType = getNameType(name);

    console.log(`[buildTransferTransaction] Building for ${name}`);
    console.log(`[buildTransferTransaction] isWrapped: ${isWrapped}`);
    console.log(`[buildTransferTransaction] nameType: ${nameType}`);
    console.log(`[buildTransferTransaction] currentOwner: ${currentOwner}`);
    console.log(
      `[buildTransferTransaction] newOwnerAddress: ${newOwnerAddress}`,
    );

    // Validate: reclaim only works for registrar
    if (reclaim && (isWrapped || nameType !== "eth-2ld")) {
      throw new Error("Reclaim is only available for unwrapped 2LD .eth names");
    }

    // Validate: asParent requires a subname
    if (asParent && nameType === "eth-2ld") {
      throw new Error("Cannot transfer as parent for 2LD names");
    }

    if (isWrapped) {
      console.log(`[buildTransferTransaction] Using NameWrapper`);
      return this.buildNameWrapperTransfer({
        name,
        newOwnerAddress,
        currentOwner,
        asParent,
      });
    }

    if (nameType === "eth-2ld") {
      console.log(`[buildTransferTransaction] Using BaseRegistrar`);
      return this.buildRegistrarTransfer({
        name,
        newOwnerAddress,
        currentOwner,
        reclaim,
      });
    }

    // Subname, unwrapped
    console.log(`[buildTransferTransaction] Using Registry`);
    return this.buildRegistryTransfer({
      name,
      newOwnerAddress,
      asParent,
    });
  }

  /**
   * Alias for backward compatibility
   */
  buildTransferServiceTransaction(params: {
    name: string;
    owner: `0x${string}`;
    isNameWrapped: boolean;
    recepientAddress: `0x${string}`;
    reclaim?: boolean;
    asParent?: boolean;
  }): TransferTransactionData {
    return this.buildTransferTransaction({
      name: params.name,
      newOwnerAddress: params.recepientAddress,
      currentOwner: params.owner,
      isWrapped: params.isNameWrapped,
      reclaim: params.reclaim,
      asParent: params.asParent,
    });
  }

  async checkSmartContractOnChains(address: `0x${string}`): Promise<{
    isContractOnMainnet: boolean;
    isContractOnBase: boolean;
    warning?: string;
  }> {
    const [isContractOnMainnet, isContractOnBase] = await Promise.all([
      this.isSmartContract(address, 1),
      this.isSmartContract(address, 8453),
    ]);

    let warning: string | undefined;

    if (isContractOnBase && !isContractOnMainnet) {
      warning =
        "⚠️ **Warning:** This appears to be a smart wallet on Base that doesn't exist on Ethereum Mainnet. \n\n" +
        "ENS names live on Mainnet, so transferring to this address may result in **permanent loss** of the name. \n\n" +
        "Please verify the recipient can access this address on Mainnet. \n\n";
    } else if (isContractOnMainnet) {
      warning =
        "⚠️ **Note:** This is a smart contract address. Make sure the contract can manage ENS names. \n\n";
    }

    return {
      isContractOnMainnet,
      isContractOnBase,
      warning,
    };
  }

  async isSmartContract(
    address: `0x${string}`,
    chainId: number = 1,
  ): Promise<boolean> {
    const chain = chainId === 8453 ? base : mainnet;

    const client = createPublicClient({
      chain,
      transport: http(),
    });

    const code = await client.getCode({ address });

    // If code is "0x" or undefined, it's an EOA
    // If code has actual bytecode, it's a smart contract
    return code !== undefined && code !== "0x";
  }
}

let transferServiceInstance: TransferService | null = null;

export function getTransferService(rpcURL?: string): TransferService {
  if (!transferServiceInstance) {
    const url = rpcURL || process.env.MAINNET_RPC_URL;

    if (!url) {
      throw new Error("MAINNET_RPC_URL is required");
    }

    transferServiceInstance = new TransferService(url);
  }

  return transferServiceInstance;
}
