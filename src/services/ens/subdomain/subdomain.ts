import {
  createPublicClient,
  encodeFunctionData,
  http,
  namehash,
  PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import {
  ENS_CONTRACTS,
  ENS_REGISTRY_ABI,
  NAME_WRAPPER_ABI,
} from "../constants";
import { FUSES } from "./subdomain.constants";
import { SubnameTransactionData } from "./subdomain.types";
import { parseSubname } from "./subdomain.utils";

export class SubdomainService {
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
   * Check if the caller owns the parent name
   */
  async conCreateSubname(
    parentName: string,
    callerAddress: `0x${string}`,
    contract: "registry" | "nameWrapper" = "nameWrapper",
  ): Promise<{ canCreate: boolean; reason?: string }> {
    const parentNode = namehash(parentName);

    try {
      if (contract === "nameWrapper") {
        // check name wrapper ownership
        const tokenId = BigInt(parentNode);
        const owner = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        });

        if (owner.toLowerCase() !== callerAddress.toLowerCase()) {
          return {
            canCreate: false,
            reason: `You don't own ${parentName}. The owner is ${owner}`,
          };
        }

        // check if CANNOT_CREATE_SUBDOMAIN fuse is burned
        const [, fuses] = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "getData",
          args: [tokenId],
        });

        if ((fuses & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
          return {
            canCreate: false,
            reason: `The CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
          };
        }

        return { canCreate: true };
      } else {
        // check registry ownership

        const owner = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_REGISTRY,
          abi: ENS_REGISTRY_ABI,
          functionName: "owner",
          args: [parentNode as `0x${string}`],
        });

        if (owner.toLowerCase() !== callerAddress.toLowerCase()) {
          return {
            canCreate: false,
            reason: `You don't own ${parentName}. The owner is ${owner}`,
          };
        }

        return { canCreate: true };
      }
    } catch (error) {
      return {
        canCreate: false,
        reason: `Error checking ownership: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }
  /**
   * Check if a subname already exists
   */
  async subnameExists(fullSubname: string): Promise<boolean> {
    const node = namehash(fullSubname);

    try {
      const owner = await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node as `0x${string}`],
      });

      return owner !== "0x0000000000000000000000000000000000000000";
    } catch (e) {
      return false;
    }
  }

  /**
   * Build transaction data for creating a subname via NameWrapper
   * This is for WRAPPED parent names (most common case)
   */
  buildCreateSubnameWrapped(params: {
    parentNode: `0x${string}`;
    label: string;
    owner: `0x${string}`;
    resolverAddress?: `0x${string}`;
    fuses?: number;
    expiry?: bigint;
  }): SubnameTransactionData {
    const {
      parentNode,
      label,
      owner,
      resolverAddress = ENS_CONTRACTS.PUBLIC_RESOLVER,
      fuses = 0,
      expiry = 0n,
    } = params;

    const data = encodeFunctionData({
      abi: NAME_WRAPPER_ABI,
      functionName: "setSubnodeRecord",
      args: [
        parentNode,
        label,
        owner,
        resolverAddress,
        0n, // TTL
        fuses,
        expiry,
      ],
    });

    return {
      to: ENS_CONTRACTS.ENS_NAMEWRAPPER,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * Build transaction data for creating a subname via Registry
   * This is for UNWRAPPED parent names
   */
  buildCreateSubnameUnwrapped(params: {
    parentNode: `0x${string}`;
    labelHash: `0x${string}`;
    owner: `0x${string}`;
    resolverAddress?: `0x${string}`;
  }): SubnameTransactionData {
    const {
      parentNode,
      labelHash,
      owner,
      resolverAddress = ENS_CONTRACTS.PUBLIC_RESOLVER,
    } = params;

    const data = encodeFunctionData({
      abi: ENS_REGISTRY_ABI,
      functionName: "setSubnodeRecord",
      args: [
        parentNode,
        labelHash,
        owner,
        resolverAddress,
        0n, // TTL
      ],
    });

    return {
      to: ENS_CONTRACTS.ENS_REGISTRY,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * High-level function: Build transaction for creating any subname
   */
  async buildCreateSubnameTransaction(
    fullSubname: string,
    owner: `0x${string}`,
    options: {
      contract?: "registry" | "nameWrapper";
      resolverAddress?: `0x${string}`;
      fuses?: number;
      expiry?: bigint;
    } = {},
  ): Promise<SubnameTransactionData> {
    const parsed = parseSubname(fullSubname);

    if (!parsed) {
      throw new Error(`Invalid subname format: ${fullSubname}`);
    }

    const contract = options.contract || "nameWrapper";

    if (contract === "nameWrapper") {
      return this.buildCreateSubnameWrapped({
        parentNode: parsed.parentNode,
        label: parsed.label,
        owner,
        resolverAddress: options.resolverAddress,
        fuses: options.fuses,
        expiry: options.expiry,
      });
    } else {
      return this.buildCreateSubnameUnwrapped({
        parentNode: parsed.parentNode,
        labelHash: parsed.labelHash,
        owner,
        resolverAddress: options.resolverAddress,
      });
    }
  }
}
