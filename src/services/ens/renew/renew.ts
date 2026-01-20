import {
	createPublicClient,
	encodeFunctionData,
	http,
	type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import {
	CONTROLLER_ABI,
	ENS_CONTRACTS,
	NAME_WRAPPER_ADDRESS,
	TIME,
} from "../constants";
import { checkExpiry } from "../ens";
import { getActualOwner, verifyOwnership } from "../utils";
import type {
	RenewalCostEstimate,
	RenewalPreparation,
	RenewalTransaction,
} from "./renew.types";

export class RenewService {
	private publicClient: PublicClient;
	private chainId: number;

	constructor(rpcURL?: string, chainId: number = 1) {
		this.chainId = chainId;
		this.publicClient = createPublicClient({
			chain: mainnet,
			transport: http(rpcURL),
		});
	}

	/**
	 * Get owner of name - handles wrapped names too
	 */
	async getNameOwner(name: string): Promise<{
		owner: `0x${string}` | null;
		isWrapped: boolean;
		error?: string;
	}> {
		return await getActualOwner(name);
	}

	/**
	 * Check if one of the user's wallets owns the name
	 */
	async verifyOwnership(
		name: string,
		userWallets: `0x${string}`[],
	): Promise<{
		owned: boolean;
		ownerWallet?: `0x${string}`;
		isWrapped: boolean;
		actualOwner?: `0x${string}`;
		error?: string;
	}> {
		console.log(`\n========== verifyOwnership (Renew) ==========`);
		console.log(`Name: ${name}`);
		console.log(`User wallets: ${userWallets.join(", ")}`);
		console.log(`==============================================\n`);

		const result = await verifyOwnership(name, userWallets);

		console.log(`[verifyOwnership] Result:`, result);

		return result;
	}

	/**
	 * Get the current expiry date for a name
	 */
	async getCurrentExpiry(name: string): Promise<{
		success: boolean;
		expiryDate?: Date;
		expiryTimestamp?: bigint;
		error?: string;
	}> {
		try {
			const expiryResult = await checkExpiry(name);

			if (!expiryResult.success) {
				return {
					success: false,
					error: expiryResult.error || "Failed to get expiry",
				};
			}

			if (!expiryResult.data) {
				return {
					success: false,
					error: "Failed to get expiry",
				};
			}

			// Get the first result from values array
			const expiryData = expiryResult.data.values[0];

			if (!expiryData) {
				return {
					success: false,
					error: "No expiry data found",
				};
			}

			if (expiryData.error) {
				return {
					success: false,
					error: expiryData.error,
				};
			}

			if (!expiryData.expiryDate) {
				return {
					success: false,
					error: `${name} does not have an expiry date (may not be registered)`,
				};
			}

			const expiryDate = expiryData.expiryDate;
			const expiryTimestamp = BigInt(Math.floor(expiryDate.getTime() / 1000));

			return {
				success: true,
				expiryDate,
				expiryTimestamp,
			};
		} catch (error) {
			console.error("Error getting expiry:", error);
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	/**
	 * Get the renewal price for a name
	 */
	async getRenewalPrice(
		name: string,
		durationYears: number,
	): Promise<RenewalCostEstimate> {
		// Remove .eth suffix if present for the contract call
		const labelName = name.replace(/\.eth$/i, "");
		const durationSeconds = BigInt(durationYears) * TIME.SECONDS_PER_YEAR;

		try {
			const priceResult = await this.publicClient.readContract({
				address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
				abi: CONTROLLER_ABI,
				functionName: "rentPrice",
				args: [labelName, durationSeconds],
			});

			const basePrice = priceResult.base;
			const premium = priceResult.premium;
			const totalCostWei = basePrice + premium;

			// Add 5% buffer for gas price fluctuations
			const recommendedValueWei = (totalCostWei * 105n) / 100n;

			return {
				name,
				durationYears,
				durationSeconds,
				basePrice,
				premium,
				totalCostWei,
				totalCostEth: (Number(totalCostWei) / 1e18).toFixed(6),
				recommendedValueWei,
				recommendedValueEth: (Number(recommendedValueWei) / 1e18).toFixed(6),
			};
		} catch (error) {
			console.error("Error getting renewal price:", error);
			throw new Error(
				`Failed to get renewal price: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
	}

	/**
	 * Prepare a complete renewal - validates ownership, gets price, calculates new expiry
	 */
	async prepareRenewal(params: {
		name: string;
		durationYears: number;
		userWallets: `0x${string}`[];
	}): Promise<{
		success: boolean;
		data?: RenewalPreparation;
		error?: string;
	}> {
		const { name, durationYears, userWallets } = params;

		// Normalize name
		const normalizedName = name.toLowerCase().endsWith(".eth")
			? name.toLowerCase()
			: `${name.toLowerCase()}.eth`;

		// 1. Verify ownership
		const ownershipResult = await this.verifyOwnership(
			normalizedName,
			userWallets,
		);

		if (!ownershipResult.owned) {
			return {
				success: false,
				error:
					ownershipResult.error ||
					`You don't own ${normalizedName}. Only the owner can renew.`,
			};
		}

		// 2. Get current expiry
		const expiryResult = await this.getCurrentExpiry(normalizedName);

		if (!expiryResult.success || !expiryResult.expiryDate) {
			return {
				success: false,
				error: expiryResult.error || "Failed to get current expiry date",
			};
		}

		// Check if name is expired (grace period is ~90 days after expiry)
		const now = new Date();
		const gracePeriodEnd = new Date(expiryResult.expiryDate);
		gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 90);

		if (now > gracePeriodEnd) {
			return {
				success: false,
				error: `${normalizedName} has expired and is past the grace period. It may be available for re-registration.`,
			};
		}

		// 3. Get renewal price
		const costEstimate = await this.getRenewalPrice(
			normalizedName,
			durationYears,
		);

		// 4. Calculate new expiry
		const newExpiry = new Date(expiryResult.expiryDate);
		newExpiry.setFullYear(newExpiry.getFullYear() + durationYears);

		const labelName = normalizedName.replace(/\.eth$/i, "");

		return {
			success: true,
			data: {
				name: normalizedName,
				labelName,
				durationYears,
				durationSeconds: costEstimate.durationSeconds,
				totalCostWei: costEstimate.totalCostWei,
				totalCostEth: costEstimate.totalCostEth,
				recommendedValueWei: costEstimate.recommendedValueWei,
				recommendedValueEth: costEstimate.recommendedValueEth,
				currentExpiry: expiryResult.expiryDate,
				newExpiry,
				ownerWallet: ownershipResult.ownerWallet!,
				isWrapped: ownershipResult.isWrapped,
			},
		};
	}

	/**
	 * Build the renewal transaction
	 */
	buildRenewalTransaction(params: {
		labelName: string; // Without .eth
		durationSeconds: bigint;
		valueWei: bigint;
	}): RenewalTransaction {
		const { labelName, durationSeconds, valueWei } = params;

		const data = encodeFunctionData({
			abi: CONTROLLER_ABI,
			functionName: "renew",
			args: [labelName, durationSeconds],
		});

		return {
			to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
			data,
			value: valueWei,
			valueHex: `0x${valueWei.toString(16)}`,
		};
	}
}

let renewServiceInstance: RenewService | null = null;

export function getRenewService(rpcURL?: string): RenewService {
	if (!renewServiceInstance) {
		renewServiceInstance = new RenewService(rpcURL);
	}
	return renewServiceInstance;
}
