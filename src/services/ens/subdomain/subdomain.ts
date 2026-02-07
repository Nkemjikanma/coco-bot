import {
	createPublicClient,
	encodeFunctionData,
	http,
	labelhash,
	namehash,
	PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { formatAddress } from "../../../utils";
import {
	ENS_CONTRACTS,
	ENS_REGISTRY_ABI,
	ENS_REGISTRY_SET_OWNER_ABI,
	NAME_WRAPPER_ABI,
	NAME_WRAPPER_ADDRESS,
	NAME_WRAPPER_TRANSFER_ABI,
	PUBLIC_RESOLVER_ABI,
} from "../constants";
import { getActualOwner, verifyOwnership } from "../utils";
import { FUSES } from "./subdomain.constants";
import { SubnameTransactionData } from "./subdomain.types";
import {
	isValidEOAAddress,
	parseSubname,
	validateSubdomainParts,
} from "./subdomain.utils";

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

			return registryOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
		} catch (error) {
			console.error(`isNameWrapped error for ${name}:`, error);
			return false;
		}
	}

	/**
	 * Get the ACTUAL owner of a name
	 */
	async getNameOwner(name: string): Promise<{
		owner: `0x${string}` | null;
		isWrapped: boolean;
		error?: string;
	}> {
		return await getActualOwner(name);
	}

	/**
	 * Verify that one of the user's wallets owns the parent name
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

		const result = await verifyOwnership(parentName, userWallets);
		return result;
	}

	/**
	 * Check if the caller owns the parent name
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

	// ============================================================
	// 3-STEP FLOW TRANSACTION BUILDERS
	// ============================================================

	/**
	 * Step 1: Create subdomain with CALLER as temporary owner
	 * This allows the caller to set records before transferring ownership
	 */
	buildStep1_CreateSubdomain(params: {
		fullSubname: string;
		caller: `0x${string}`;
		isWrapped: boolean;
	}): SubnameTransactionData {
		const parsed = parseSubname(params.fullSubname);
		if (!parsed) {
			throw new Error(`Invalid subname: ${params.fullSubname}`);
		}

		const resolverAddress = ENS_CONTRACTS.PUBLIC_RESOLVER;

		console.log(`[buildStep1] Creating subdomain: ${params.fullSubname}`);
		console.log(`[buildStep1] Temporary owner (caller): ${params.caller}`);
		console.log(`[buildStep1] isWrapped: ${params.isWrapped}`);

		if (params.isWrapped) {
			const data = encodeFunctionData({
				abi: NAME_WRAPPER_ABI,
				functionName: "setSubnodeRecord",
				args: [
					parsed.parentNode,
					parsed.label,
					params.caller, // CALLER is temporary owner
					resolverAddress,
					0n, // TTL
					0, // Fuses (none burned)
					0n, // Expiry (inherit from parent)
				],
			});

			return {
				to: NAME_WRAPPER_ADDRESS as `0x${string}`,
				data,
				value: 0n,
				chainId: this.chainId,
			};
		} else {
			const data = encodeFunctionData({
				abi: ENS_REGISTRY_ABI,
				functionName: "setSubnodeRecord",
				args: [
					parsed.parentNode,
					parsed.labelHash,
					params.caller, // CALLER is temporary owner
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
	}

	/**
	 * Step 2: Set address record
	 * Since caller is the owner (from Step 1), they can set the address record
	 */
	buildStep2_SetAddress(params: {
		fullSubname: string;
		resolveAddress: `0x${string}`;
	}): SubnameTransactionData {
		const subnameNode = namehash(params.fullSubname) as `0x${string}`;

		console.log(`[buildStep2] Setting address for: ${params.fullSubname}`);
		console.log(`[buildStep2] Address: ${params.resolveAddress}`);

		const data = encodeFunctionData({
			abi: PUBLIC_RESOLVER_ABI,
			functionName: "setAddr",
			args: [subnameNode, params.resolveAddress],
		});

		return {
			to: ENS_CONTRACTS.PUBLIC_RESOLVER,
			data,
			value: 0n,
			chainId: this.chainId,
		};
	}

	/**
	 * Step 3: Transfer ownership from caller to recipient
	 * This is the final step - recipient becomes the owner
	 */
	buildStep3_TransferOwnership(params: {
		fullSubname: string;
		caller: `0x${string}`;
		recipient: `0x${string}`;
		isWrapped: boolean;
	}): SubnameTransactionData {
		const subnameNode = namehash(params.fullSubname) as `0x${string}`;

		console.log(
			`[buildStep3] Transferring ownership of: ${params.fullSubname}`,
		);
		console.log(`[buildStep3] From: ${params.caller}`);
		console.log(`[buildStep3] To: ${params.recipient}`);

		if (params.isWrapped) {
			// For wrapped names, use NameWrapper's safeTransferFrom (ERC1155)
			const data = encodeFunctionData({
				abi: NAME_WRAPPER_TRANSFER_ABI,
				functionName: "safeTransferFrom",
				args: [
					params.caller,
					params.recipient,
					BigInt(subnameNode), // tokenId is the namehash as uint256
					1n, // amount (always 1 for ERC1155)
					"0x" as `0x${string}`, // data (empty)
				],
			});

			return {
				to: NAME_WRAPPER_ADDRESS as `0x${string}`,
				data,
				value: 0n,
				chainId: this.chainId,
			};
		} else {
			// For unwrapped names, use Registry.setOwner
			const data = encodeFunctionData({
				abi: ENS_REGISTRY_SET_OWNER_ABI,
				functionName: "setOwner",
				args: [subnameNode, params.recipient],
			});

			return {
				to: ENS_CONTRACTS.ENS_REGISTRY,
				data,
				value: 0n,
				chainId: this.chainId,
			};
		}
	}

	/**
	 * Get all three transaction steps for subdomain creation with address assignment
	 *
	 * This is the correct flow where ALL transactions are signed by the parent owner:
	 * 1. Create subdomain with caller as owner
	 * 2. Set address record (caller can do this because they're owner)
	 * 3. Transfer ownership to recipient
	 */
	buildSubdomainWithAddressSteps(params: {
		fullSubname: string;
		resolveAddress: `0x${string}`;
		caller: `0x${string}`;
		recipient: `0x${string}`;
		isWrapped: boolean;
	}): {
		step1: SubnameTransactionData;
		step2: SubnameTransactionData;
		step3: SubnameTransactionData;
	} {
		return {
			step1: this.buildStep1_CreateSubdomain({
				fullSubname: params.fullSubname,
				caller: params.caller,
				isWrapped: params.isWrapped,
			}),
			step2: this.buildStep2_SetAddress({
				fullSubname: params.fullSubname,
				resolveAddress: params.resolveAddress,
			}),
			step3: this.buildStep3_TransferOwnership({
				fullSubname: params.fullSubname,
				caller: params.caller,
				recipient: params.recipient,
				isWrapped: params.isWrapped,
			}),
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
