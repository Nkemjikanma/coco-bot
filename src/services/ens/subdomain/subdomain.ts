import {
  createPublicClient,
  encodeFunctionData,
  http,
  namehash,
  labelhash,
  PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import {
  ENS_CONTRACTS,
  ENS_REGISTRY_ABI,
  NAME_WRAPPER_ABI,
  PUBLIC_RESOLVER_ABI,
} from "../constants";
import { FUSES } from "./subdomain.constants";
import { SubnameTransactionData } from "./subdomain.types";
import {
  isValidEOAAddress,
  parseSubname,
  validateSubdomainParts,
} from "./subdomain.utils";
import { formatAddress } from "../../../utils";

// NameWrapper contract address
const NAME_WRAPPER_ADDRESS = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";

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
   * Check if a name is wrapped by checking if Registry owner is NameWrapper
   */
  async isNameWrapped(name: string): Promise<boolean> {
    const node = namehash(name);

    try {
      const registryOwner = (await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node as `0x${string}`],
      })) as string;

      // Compare lowercase to handle checksum differences
      return registryOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
    } catch (error) {
      console.error(`isNameWrapped error for ${name}:`, error);
      return false;
    }
  }

  /**
   * Get the ACTUAL owner of a name
   * - For wrapped names: queries NameWrapper.ownerOf(tokenId)
   * - For unwrapped names: returns Registry owner
   */
  async getNameOwner(name: string): Promise<{
    owner: `0x${string}` | null;
    isWrapped: boolean;
    error?: string;
  }> {
    const node = namehash(name);

    try {
      // Step 1: Check Registry owner
      const registryOwner = (await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node as `0x${string}`],
      })) as string;

      console.log(`[getNameOwner] ${name} Registry owner: ${registryOwner}`);

      // If zero address, name doesn't exist
      if (registryOwner === "0x0000000000000000000000000000000000000000") {
        return {
          owner: null,
          isWrapped: false,
          error: `${name} is not registered`,
        };
      }

      // Step 2: Check if wrapped (Registry owner == NameWrapper)
      const isWrapped =
        registryOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
      console.log(`[getNameOwner] ${name} isWrapped: ${isWrapped}`);

      if (isWrapped) {
        // Step 3: For wrapped names, get owner from NameWrapper
        const tokenId = BigInt(node);
        console.log(
          `[getNameOwner] Querying NameWrapper.ownerOf(${tokenId})...`,
        );

        try {
          const wrapperOwner = (await this.publicClient.readContract({
            address: NAME_WRAPPER_ADDRESS as `0x${string}`,
            abi: NAME_WRAPPER_ABI,
            functionName: "ownerOf",
            args: [tokenId],
          })) as string;

          console.log(
            `[getNameOwner] ${name} NameWrapper owner: ${wrapperOwner}`,
          );

          return {
            owner: wrapperOwner as `0x${string}`,
            isWrapped: true,
          };
        } catch (wrapperError) {
          console.error(
            `[getNameOwner] NameWrapper.ownerOf failed:`,
            wrapperError,
          );
          return {
            owner: null,
            isWrapped: true,
            error: `Failed to get owner from NameWrapper: ${wrapperError}`,
          };
        }
      }

      // Not wrapped - Registry owner is the actual owner
      return {
        owner: registryOwner as `0x${string}`,
        isWrapped: false,
      };
    } catch (error) {
      console.error(`[getNameOwner] Error for ${name}:`, error);
      return {
        owner: null,
        isWrapped: false,
        error: `Failed to get owner: ${error}`,
      };
    }
  }

  /**
   * ✅ NEW METHOD: Verify that one of the user's wallets owns the parent name
   * This is what handleSubdomainCommand calls
   */
  async verifyParentOwnership(
    parentName: string,
    userWallets: `0x${string}`[],
  ): Promise<{
    owned: boolean;
    ownerWallet?: `0x${string}`;
    isWrapped: boolean;
    actualOwner?: `0x${string}`;
    error?: string;
  }> {
    console.log(`\n========== verifyParentOwnership ==========`);
    console.log(`Parent name: ${parentName}`);
    console.log(`User wallets: ${userWallets.join(", ")}`);
    console.log(`NameWrapper address: ${NAME_WRAPPER_ADDRESS}`);
    console.log(`============================================\n`);

    // Get the actual owner
    const ownerResult = await this.getNameOwner(parentName);

    if (!ownerResult.owner) {
      return {
        owned: false,
        isWrapped: false,
        error: ownerResult.error || `${parentName} is not registered`,
      };
    }

    console.log(`[verifyParentOwnership] Actual owner: ${ownerResult.owner}`);
    console.log(`[verifyParentOwnership] Is wrapped: ${ownerResult.isWrapped}`);

    // Check if any user wallet matches the actual owner
    const ownerLower = ownerResult.owner.toLowerCase();
    const matchingWallet = userWallets.find(
      (wallet) => wallet.toLowerCase() === ownerLower,
    );

    if (matchingWallet) {
      console.log(`[verifyParentOwnership] ✅ Match found: ${matchingWallet}`);

      // For wrapped names, check fuses
      if (ownerResult.isWrapped) {
        const node = namehash(parentName);
        const tokenId = BigInt(node);

        try {
          const [, fuses] = (await this.publicClient.readContract({
            address: NAME_WRAPPER_ADDRESS as `0x${string}`,
            abi: NAME_WRAPPER_ABI,
            functionName: "getData",
            args: [tokenId],
          })) as [string, number, bigint];

          if ((fuses & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
            return {
              owned: false,
              ownerWallet: matchingWallet,
              isWrapped: true,
              actualOwner: ownerResult.owner,
              error: `CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
            };
          }
        } catch (fuseError) {
          console.error(
            `[verifyParentOwnership] Error checking fuses:`,
            fuseError,
          );
          // Continue anyway - fuse check is optional
        }
      }

      return {
        owned: true,
        ownerWallet: matchingWallet,
        isWrapped: ownerResult.isWrapped,
        actualOwner: ownerResult.owner,
      };
    }

    // No match found
    console.log(`[verifyParentOwnership] ❌ No matching wallet`);
    return {
      owned: false,
      isWrapped: ownerResult.isWrapped,
      actualOwner: ownerResult.owner,
      error: `None of your wallets own ${parentName}. The owner is ${ownerResult.owner}`,
    };
  }

  /**
   * Check if the caller owns the parent name (original method for single wallet check)
   */
  async canCreateSubname(
    parentName: string,
    callerAddress: `0x${string}`,
    contract: "registry" | "nameWrapper" = "nameWrapper",
  ): Promise<{ canCreate: boolean; reason?: string }> {
    const parentNode = namehash(parentName);

    try {
      if (contract === "nameWrapper") {
        const tokenId = BigInt(parentNode);
        const owner = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        });

        if ((owner as string).toLowerCase() !== callerAddress.toLowerCase()) {
          return {
            canCreate: false,
            reason: `You don't own ${parentName}. The owner is ${owner}`,
          };
        }

        const [, fuses] = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "getData",
          args: [tokenId],
        });

        if (((fuses as number) & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
          return {
            canCreate: false,
            reason: `CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
          };
        }

        return { canCreate: true };
      } else {
        const owner = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_REGISTRY,
          abi: ENS_REGISTRY_ABI,
          functionName: "owner",
          args: [parentNode as `0x${string}`],
        });

        if ((owner as string).toLowerCase() !== callerAddress.toLowerCase()) {
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

      return (owner as string) !== "0x0000000000000000000000000000000000000000";
    } catch {
      return false;
    }
  }

  /**
   * Build transaction for wrapped names (via NameWrapper)
   */
  buildCreateSubnameWrapped(params: {
    parentNode: `0x${string}`;
    label: string;
    owner: `0x${string}`;
    resolverAddress?: `0x${string}`;
    fuses?: number;
    expiry?: bigint;
  }): SubnameTransactionData {
    const resolverAddress =
      params.resolverAddress || ENS_CONTRACTS.PUBLIC_RESOLVER;

    const data = encodeFunctionData({
      abi: NAME_WRAPPER_ABI,
      functionName: "setSubnodeRecord",
      args: [
        params.parentNode,
        params.label,
        params.owner,
        resolverAddress,
        0n,
        params.fuses || 0,
        params.expiry || 0n,
      ],
    });

    return {
      to: NAME_WRAPPER_ADDRESS as `0x${string}`,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }

  /**
   * Build transaction for unwrapped names (via Registry)
   */
  buildCreateSubnameUnwrapped(params: {
    parentNode: `0x${string}`;
    labelHash: `0x${string}`;
    owner: `0x${string}`;
    resolverAddress?: `0x${string}`;
  }): SubnameTransactionData {
    const resolverAddress =
      params.resolverAddress || ENS_CONTRACTS.PUBLIC_RESOLVER;

    const data = encodeFunctionData({
      abi: ENS_REGISTRY_ABI,
      functionName: "setSubnodeRecord",
      args: [
        params.parentNode,
        params.labelHash,
        params.owner,
        resolverAddress,
        0n,
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
   * Build transaction based on whether parent is wrapped
   */
  buildCreateSubnameTransaction(params: {
    fullSubname: string;
    owner: `0x${string}`;
    isWrapped: boolean;
    resolverAddress?: `0x${string}`;
    fuses?: number;
    expiry?: bigint;
  }): SubnameTransactionData {
    const parsed = parseSubname(params.fullSubname);
    if (!parsed) {
      throw new Error(`Invalid subname: ${params.fullSubname}`);
    }

    console.log(
      `[buildCreateSubnameTransaction] Building for ${params.fullSubname}`,
    );
    console.log(
      `[buildCreateSubnameTransaction] isWrapped: ${params.isWrapped}`,
    );
    console.log(`[buildCreateSubnameTransaction] owner: ${params.owner}`);

    if (params.isWrapped) {
      console.log(
        `[buildCreateSubnameTransaction] Using NameWrapper at ${NAME_WRAPPER_ADDRESS}`,
      );
      return this.buildCreateSubnameWrapped({
        parentNode: parsed.parentNode,
        label: parsed.label,
        owner: params.owner,
        resolverAddress: params.resolverAddress,
        fuses: params.fuses,
        expiry: params.expiry,
      });
    } else {
      console.log(
        `[buildCreateSubnameTransaction] Using Registry at ${ENS_CONTRACTS.ENS_REGISTRY}`,
      );
      return this.buildCreateSubnameUnwrapped({
        parentNode: parsed.parentNode,
        labelHash: parsed.labelHash,
        owner: params.owner,
        resolverAddress: params.resolverAddress,
      });
    }
  }
}

// ============ Exporting singleton for convenience ============
let subdomainServiceInstance: SubdomainService | null = null;

export function getSubdomainService(rpcUrl?: string): SubdomainService {
  if (!subdomainServiceInstance) {
    const url = rpcUrl || process.env.MAINNET_RPC_URL;
    if (!url) {
      throw new Error("MAINNET_RPC_URL is required");
    }
    subdomainServiceInstance = new SubdomainService(url);
  }
  return subdomainServiceInstance;
}
