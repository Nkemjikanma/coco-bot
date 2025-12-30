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
import {
  SubdomainPrepareResult,
  SubnameTransactionData,
} from "./subdomain.types";
import {
  isValidEOAAddress,
  parseSubname,
  validateSubdomainParts,
} from "./subdomain.utils";
import { formatAddress } from "../../../utils";

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
   * Resolve an ENS name or validate an Ethereum address
   */
  async resolveRecipient(
    recipient: string,
  ): Promise<{ address: `0x${string}` | null; error?: string }> {
    // Check if it's already an address
    if (isValidEOAAddress(recipient)) {
      return { address: recipient as `0x${string}` };
    }

    // Try to resolve as ENS name
    if (recipient.endsWith(".eth")) {
      try {
        const address = await this.publicClient.getEnsAddress({
          name: recipient,
        });

        if (!address) {
          return {
            address: null,
            error: `ENS name "${recipient}" does not resolve to an address`,
          };
        }

        return { address };
      } catch (error) {
        return {
          address: null,
          error: `Failed to resolve ENS name "${recipient}"`,
        };
      }
    }

    return {
      address: null,
      error: `Invalid recipient "${recipient}". Must be an Ethereum address or ENS name.`,
    };
  }
  /**
   * Check if a parent name is wrapped in NameWrapper
   */
  async isNameWrapped(parentName: string): Promise<boolean> {
    try {
      const node = namehash(parentName);
      const isWrapped = await this.publicClient.readContract({
        address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
        abi: NAME_WRAPPER_ABI,
        functionName: "isWrapped",
        args: [node as `0x${string}`],
      });
      return isWrapped as boolean;
    } catch {
      // If the call fails, assume not wrapped
      return false;
    }
  }

  /**
   * Check if the caller owns the parent name (can create subnames)
   */
  async canCreateSubname(
    parentName: string,
    callerAddress: `0x${string}`,
  ): Promise<{ canCreate: boolean; reason?: string; isWrapped: boolean }> {
    const parentNode = namehash(parentName);

    try {
      // First check if the name is wrapped
      const isWrapped = await this.isNameWrapped(parentName);

      if (isWrapped) {
        // Check NameWrapper ownership
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
            reason: `You don't own ${parentName}. The owner is ${formatAddress(owner as string)}`,
            isWrapped: true,
          };
        }

        // Check if CANNOT_CREATE_SUBDOMAIN fuse is burned
        const [, fuses] = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_NAMEWRAPPER,
          abi: NAME_WRAPPER_ABI,
          functionName: "getData",
          args: [tokenId],
        });

        if (((fuses as number) & FUSES.CANNOT_CREATE_SUBDOMAIN) !== 0) {
          return {
            canCreate: false,
            reason: `The CANNOT_CREATE_SUBDOMAIN fuse is burned on ${parentName}`,
            isWrapped: true,
          };
        }

        return { canCreate: true, isWrapped: true };
      } else {
        // Check Registry ownership for unwrapped names
        const owner = await this.publicClient.readContract({
          address: ENS_CONTRACTS.ENS_REGISTRY,
          abi: ENS_REGISTRY_ABI,
          functionName: "owner",
          args: [parentNode as `0x${string}`],
        });

        if ((owner as string).toLowerCase() !== callerAddress.toLowerCase()) {
          return {
            canCreate: false,
            reason: `You don't own ${parentName}. The owner is ${formatAddress(owner as string)}`,
            isWrapped: false,
          };
        }

        return { canCreate: true, isWrapped: false };
      }
    } catch (error) {
      return {
        canCreate: false,
        reason: `Error checking ownership: ${error instanceof Error ? error.message : "Unknown error"}`,
        isWrapped: false,
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
   * Verify parent domain ownership against user's wallets
   */
  async verifyParentOwnership(
    parentName: string,
    userWallets: `0x${string}`[],
  ): Promise<{
    owned: boolean;
    ownerWallet?: `0x${string}`;
    isWrapped: boolean;
    error?: string;
  }> {
    for (const wallet of userWallets) {
      const result = await this.canCreateSubname(parentName, wallet);
      if (result.canCreate) {
        return {
          owned: true,
          ownerWallet: wallet,
          isWrapped: result.isWrapped,
        };
      }
    }

    return {
      owned: false,
      isWrapped: false,
      error: `None of your wallets own ${parentName}`,
    };
  }
  /**
   * Prepare subdomain assignment - validate everything before building transactions
   */
  async prepareSubdomainAssignment(
    subdomainInput: string,
    recipientInput: string,
    userWallets: `0x${string}`[],
  ): Promise<SubdomainPrepareResult> {
    try {
      // Step 1: Parse subdomain input
      const parsed = parseSubname(subdomainInput);
      if (!parsed) {
        return {
          success: false,
          reason:
            'Invalid format. Use "subdomain.domain.eth" (e.g., "alice.mydomain.eth")',
        };
      }

      const {
        label: subdomain,
        parent: domain,
        full: fullName,
        parentNode,
        labelHash,
      } = parsed;

      // Step 2: Validate subdomain and domain labels
      const domainLabel = domain.replace(".eth", "");
      const validation = validateSubdomainParts(subdomain, domainLabel);
      if (!validation.valid) {
        return {
          success: false,
          reason: validation.reason,
        };
      }

      // Step 3: Verify parent domain ownership
      const ownershipCheck = await this.verifyParentOwnership(
        domain,
        userWallets,
      );
      if (!ownershipCheck.owned) {
        return {
          success: false,
          reason: ownershipCheck.error,
        };
      }

      // Step 4: Resolve recipient
      const recipientResult = await this.resolveRecipient(recipientInput);
      if (!recipientResult.address) {
        return {
          success: false,
          reason: recipientResult.error,
        };
      }

      // Step 5: Check if subdomain already exists
      const exists = await this.subnameExists(fullName);
      if (exists) {
        return {
          success: false,
          reason: `Subdomain "${fullName}" already exists`,
        };
      }
      // Step 6: Calculate subdomain node
      const subdomainNode = namehash(fullName) as `0x${string}`;

      // Success - return all prepared data
      return {
        success: true,
        subdomain,
        domain,
        fullName,
        parentNode,
        subdomainNode,
        labelHash,
        recipient: recipientResult.address,
        ownerWallet: ownershipCheck.ownerWallet,
        isWrapped: ownershipCheck.isWrapped,
      };
    } catch (error) {
      console.error("Error preparing subdomain assignment:", error);
      return {
        success: false,
        reason: "An unexpected error occurred while preparing the assignment",
      };
    }
  }

  /**
   * Build transaction for creating a subname (wrapped names via NameWrapper)
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
   * Build transaction for creating a subname (unwrapped names via Registry)
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
   * Build transaction to set the address record on the resolver
   */
  buildSetAddressRecord(params: {
    subdomainNode: `0x${string}`;
    address: `0x${string}`;
    resolverAddress?: `0x${string}`;
  }): SubnameTransactionData {
    const resolverAddress =
      params.resolverAddress || ENS_CONTRACTS.PUBLIC_RESOLVER;

    const data = encodeFunctionData({
      abi: PUBLIC_RESOLVER_ABI,
      functionName: "setAddr",
      args: [params.subdomainNode, params.address],
    });

    return {
      to: resolverAddress,
      data,
      value: 0n,
      chainId: this.chainId,
    };
  }
  /**
   * Build all transactions needed for subdomain assignment
   * Returns transactions based on whether the parent is wrapped or not
   */
  buildSubdomainAssignmentTransactions(params: {
    fullSubname: string;
    recipient: `0x${string}`;
    isWrapped: boolean;
    fuses?: number;
    expiry?: bigint;
  }): {
    step1_createSubname: SubnameTransactionData;
    step2_setAddress: SubnameTransactionData;
    description: string;
  } {
    const parsed = parseSubname(params.fullSubname);
    if (!parsed) {
      throw new Error(`Invalid subname: ${params.fullSubname}`);
    }

    const subdomainNode = namehash(params.fullSubname) as `0x${string}`;

    let step1: SubnameTransactionData;

    if (params.isWrapped) {
      // Use NameWrapper for wrapped names
      step1 = this.buildCreateSubnameWrapped({
        parentNode: parsed.parentNode,
        label: parsed.label,
        owner: params.recipient,
        fuses: params.fuses || FUSES.EMANCIPATED_AND_EXTENDABLE,
        expiry: params.expiry,
      });
    } else {
      // Use Registry for unwrapped names
      step1 = this.buildCreateSubnameUnwrapped({
        parentNode: parsed.parentNode,
        labelHash: parsed.labelHash,
        owner: params.recipient,
      });
    }

    // Step 2: Set address record (same for both wrapped and unwrapped)
    const step2 = this.buildSetAddressRecord({
      subdomainNode,
      address: params.recipient,
    });

    return {
      step1_createSubname: step1,
      step2_setAddress: step2,
      description: `Transaction 1: Create subdomain and set owner\nTransaction 2: Set address record to point to recipient`,
    };
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
