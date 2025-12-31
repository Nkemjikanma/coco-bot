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
const NAME_WRAPPER_ADDRESS =
  "0xD4416b13d2b3a9aBae7AcdBB3092D31d512a2C71" as const;

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
   * Check if a name is wrapped in NameWrapper
   */
  async isNameWrapped(name: string): Promise<boolean> {
    const node = namehash(name);

    try {
      // Check who owns the name in the Registry
      const registryOwner = await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node as `0x${string}`],
      });

      // If the Registry owner is the NameWrapper, the name is wrapped
      return (
        (registryOwner as string).toLowerCase() ===
        NAME_WRAPPER_ADDRESS.toLowerCase()
      );
    } catch (error) {
      console.error("Error checking if name is wrapped:", error);
      return false;
    }
  }

  /**
   * Get the actual owner of a name (handles both wrapped and unwrapped)
   */
  async getNameOwner(name: string): Promise<{
    owner: `0x${string}` | null;
    isWrapped: boolean;
    error?: string;
  }> {
    const node = namehash(name);

    try {
      // First check Registry owner
      const registryOwner = (await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_REGISTRY,
        abi: ENS_REGISTRY_ABI,
        functionName: "owner",
        args: [node as `0x${string}`],
      })) as string;

      // If owner is zero address, name doesn't exist
      if (registryOwner === "0x0000000000000000000000000000000000000000") {
        return {
          owner: null,
          isWrapped: false,
          error: `Name ${name} is not registered`,
        };
      }

      // If Registry owner is NameWrapper, get the actual owner from NameWrapper
      if (registryOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
        const tokenId = BigInt(node);

        try {
          const wrapperOwner = (await this.publicClient.readContract({
            address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
            abi: NAME_WRAPPER_ABI,
            functionName: "ownerOf",
            args: [tokenId],
          })) as string;

          return {
            owner: wrapperOwner as `0x${string}`,
            isWrapped: true,
          };
        } catch (err) {
          // Token might not exist in wrapper
          return {
            owner: null,
            isWrapped: true,
            error: "Failed to get owner from NameWrapper",
          };
        }
      }

      // Name is not wrapped, Registry owner is the actual owner
      return {
        owner: registryOwner as `0x${string}`,
        isWrapped: false,
      };
    } catch (error) {
      console.error("Error getting name owner:", error);
      return { owner: null, isWrapped: false, error: "Failed to get owner" };
    }
  }

  /**
   * Check if the caller owns the parent name (can create subnames)
   * ✅ FIXED: Automatically detects wrapped vs unwrapped names
   */
  async canCreateSubname(
    parentName: string,
    callerAddress: `0x${string}`,
  ): Promise<{ canCreate: boolean; isWrapped: boolean; reason?: string }> {
    const parentNode = namehash(parentName);

    try {
      // Get the actual owner (handles wrapped vs unwrapped automatically)
      const ownerResult = await this.getNameOwner(parentName);

      if (!ownerResult.owner) {
        return {
          canCreate: false,
          isWrapped: false,
          reason: ownerResult.error || `${parentName} is not registered`,
        };
      }

      // Check if caller is the owner
      if (ownerResult.owner.toLowerCase() !== callerAddress.toLowerCase()) {
        return {
          canCreate: false,
          isWrapped: ownerResult.isWrapped,
          reason: `You don't own ${parentName}. The owner is ${ownerResult.owner}`,
        };
      }

      // If wrapped, also check fuses
      if (ownerResult.isWrapped) {
        const tokenId = BigInt(parentNode);

        const [, fuses] = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "getData",
          args: [tokenId],
        });

        if (((fuses as number) & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
          return {
            canCreate: false,
            isWrapped: true,
            reason: `The CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
          };
        }
      }

      return { canCreate: true, isWrapped: ownerResult.isWrapped };
    } catch (error) {
      console.error("Error checking canCreateSubname:", error);
      return {
        canCreate: false,
        isWrapped: false,
        reason: `Error checking ownership: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Verify parent domain ownership against user's wallets
   * ✅ FIXED: Checks all wallets and handles wrapped names
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
    console.log(`verifyParentOwnership: Checking ${parentName}`);
    console.log(`verifyParentOwnership: User wallets:`, userWallets);

    // First, get the actual owner of the name
    const ownerResult = await this.getNameOwner(parentName);

    console.log(`verifyParentOwnership: Owner result:`, ownerResult);

    if (!ownerResult.owner) {
      return {
        owned: false,
        isWrapped: false,
        error: ownerResult.error || `${parentName} is not registered`,
      };
    }

    // Check if any of the user's wallets is the owner
    const matchingWallet = userWallets.find(
      (wallet) => wallet.toLowerCase() === ownerResult.owner!.toLowerCase(),
    );

    if (matchingWallet) {
      console.log(
        `verifyParentOwnership: Found matching wallet: ${matchingWallet}`,
      );

      // If wrapped, check fuses
      if (ownerResult.isWrapped) {
        const parentNode = namehash(parentName);
        const tokenId = BigInt(parentNode);

        try {
          const [, fuses] = await this.publicClient.readContract({
            address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
            abi: NAME_WRAPPER_ABI,
            functionName: "getData",
            args: [tokenId],
          });

          if (((fuses as number) & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
            return {
              owned: false,
              ownerWallet: matchingWallet,
              isWrapped: true,
              actualOwner: ownerResult.owner,
              error: `The CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
            };
          }
        } catch (err) {
          console.error("Error checking fuses:", err);
        }
      }

      return {
        owned: true,
        ownerWallet: matchingWallet,
        isWrapped: ownerResult.isWrapped,
        actualOwner: ownerResult.owner,
      };
    }

    // No matching wallet found
    console.log(
      `verifyParentOwnership: No matching wallet. Actual owner: ${ownerResult.owner}`,
    );

    return {
      owned: false,
      isWrapped: ownerResult.isWrapped,
      actualOwner: ownerResult.owner,
      error: `None of your wallets own ${parentName}. The owner is ${ownerResult.owner}`,
    };
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
   * Build transaction for creating a subname via NameWrapper (for wrapped parents)
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
        0n, // TTL
        params.fuses || 0,
        params.expiry || 0n,
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
   * Build transaction for creating a subname via Registry (for unwrapped parents)
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
   * Build transaction based on whether parent is wrapped or not
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

    if (params.isWrapped) {
      return this.buildCreateSubnameWrapped({
        parentNode: parsed.parentNode,
        label: parsed.label,
        owner: params.owner,
        resolverAddress: params.resolverAddress,
        fuses: params.fuses,
        expiry: params.expiry,
      });
    } else {
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
