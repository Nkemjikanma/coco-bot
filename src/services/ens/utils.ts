import type {
	GetNameHistoryReturnType,
	GetNamesForAddressReturnType,
	NameWithRelation,
} from "@ensdomains/ensjs/subgraph";
import {
	concat,
	createPublicClient,
	http,
	keccak256,
	type PublicClient,
	toBytes,
	toHex,
	zeroAddress,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import type {
	ENSHistoryEvent,
	ENSPortfolioName,
	HistoryData,
	PortfolioData,
} from "../../api";
import { clearAllUserFlows, clearUserPendingCommand } from "../../db";
import {
	BASE_REGISTRAR_ABI,
	ENS_CONTRACTS,
	ENS_REGISTRY_ABI,
	ENS_VALIDATION,
	MAINNET_RPC_URL,
	NAME_WRAPPER_ABI,
	NAME_WRAPPER_ADDRESS,
} from "./constants";
import type { OwnerInfo } from "./types";

// Lazy-initialized client
let _client: PublicClient | null = null;

function getClient(): PublicClient {
	if (!_client) {
		if (!MAINNET_RPC_URL) {
			throw new Error("MAINNET_RPC_URL is required");
		}
		_client = createPublicClient({
			chain: mainnet,
			transport: http(MAINNET_RPC_URL),
		});
	}
	return _client;
}
/**
 * Normalizes and validates an ENS domain name
 */
export function normalizeENSName(domainName: string): {
	normalized: string;
	valid: boolean;
	reason?: string;
} {
	try {
		// Remove .eth suffix if present
		const label = domainName
			.toLowerCase()
			.trim()
			.replace(ENS_VALIDATION.SUFFIX, "");

		// Normalize (handles Unicode)
		const normalized = normalize(label);

		// Validate length
		if (normalized.length < ENS_VALIDATION.MIN_LENGTH) {
			return {
				normalized,
				valid: false,
				reason: `Name must be at least ${ENS_VALIDATION.MIN_LENGTH} characters`,
			};
		}

		return { normalized, valid: true };
	} catch (error) {
		return {
			normalized: "",
			valid: false,
			reason: "Invalid ENS name format",
		};
	}
}

/**
 * Converts an ENS label to its tokenId (labelhash)
 * Used by BaseRegistrar contract
 */
export function getTokenId(label: string): bigint {
	const hash = keccak256(toHex(label));
	return BigInt(hash);
}

/**
 * Computes ENS namehash for a full domain name
 * Used by ENS Registry contract
 */
export function namehash(name: string): `0x${string}` {
	// For .eth domains: namehash(eth) + keccak256(label)
	const ethNode =
		"0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae";
	const label = name.toLowerCase().replace(".eth", "");
	const labelHash = keccak256(toBytes(label));

	return keccak256(concat([toBytes(ethNode), toBytes(labelHash)]));
}

// format response from ensjs to match our api response
export function mapEnsHistoryResponse(
	data: GetNameHistoryReturnType,
): HistoryData {
	if (!data) {
		return { events: [] };
	}

	const events: ENSHistoryEvent[] = [];

	// Map domain events
	for (const event of data.domainEvents) {
		switch (event.type) {
			case "Transfer":
				events.push({
					type: "transferred",
					blockNumber: event.blockNumber,
					transactionHash: event.transactionID,
					to: event.owner,
				});
				break;

			case "NameWrapped":
				events.push({
					type: "wrapped",
					blockNumber: event.blockNumber,
					transactionHash: event.transactionID,
					owner: event.owner,
					expiryDate: event.expiryDate,
				});
				break;

			case "NameUnwrapped":
				events.push({
					type: "unwrapped",
					blockNumber: event.blockNumber,
					transactionHash: event.transactionID,
					owner: event.owner,
				});
				break;

			case "ExpiryExtended":
				events.push({
					type: "expiry_extended",
					blockNumber: event.blockNumber,
					transactionHash: event.transactionID,
					expiryDate: event.expiryDate,
				});
				break;

			// Skip technical events: NewOwner, NewResolver, NewTTL, WrappedTransfer, FusesSet
			default:
				break;
		}
	}

	// Map registration events
	if (data.registrationEvents) {
		for (const event of data.registrationEvents) {
			switch (event.type) {
				case "NameRegistered":
					events.push({
						type: "registered",
						blockNumber: event.blockNumber,
						transactionHash: event.transactionID,
						to: event.registrant,
						expiryDate: event.expiryDate,
					});
					break;

				case "NameRenewed":
					events.push({
						type: "renewed",
						blockNumber: event.blockNumber,
						transactionHash: event.transactionID,
						expiryDate: event.expiryDate,
					});
					break;

				case "NameTransferred":
					events.push({
						type: "transferred",
						blockNumber: event.blockNumber,
						transactionHash: event.transactionID,
						to: event.newOwner,
					});
					break;
			}
		}
	}

	// Sort by block number (chronological)
	events.sort((a, b) => a.blockNumber - b.blockNumber);

	return { events };
}

export function mapNamesForAddressToPortfolioData(
	namesFromSubgraph: GetNamesForAddressReturnType,
	primaryName?: string | null,
): PortfolioData {
	const normalizedPrimary = primaryName?.toLowerCase() ?? null;

	const names: ENSPortfolioName[] = namesFromSubgraph
		// If ENSJS can return null names, drop them
		.filter(
			(n): n is NameWithRelation & { name: string } =>
				typeof n.name === "string" && n.name.length > 0,
		)
		.map((n) => {
			const expiry = dateWithValueToDate(n.expiryDate);
			const { expiryDate, isExpired } = computeExpiry(expiry);

			const isPrimary =
				normalizedPrimary != null && n.name.toLowerCase() === normalizedPrimary;

			return {
				name: n.name,
				expiryDate,
				isExpired,
				isPrimary,
			};
		});

	// Optional: sort so primary is first, then by expiry asc, then name
	names.sort((a, b) => {
		if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
		const tA =
			(a.expiryDate as Date).getTime?.() ??
			new Date(a.expiryDate as any).getTime();
		const tB =
			(b.expiryDate as Date).getTime?.() ??
			new Date(b.expiryDate as any).getTime();
		if (tA !== tB) return tA - tB;
		return a.name.localeCompare(b.name);
	});

	return {
		names,
		totalCount: names.length,
		primaryName: primaryName ?? null,
	};
}

function dateWithValueToDate(
	d: { value: number; date?: Date } | null | undefined,
): Date | null {
	if (!d) return null;
	if (d.date instanceof Date) return d.date;
	// value is typically seconds since epoch in ENS subgraph types
	return new Date(d.value * 1000);
}

function computeExpiry(expiryDate: Date | null): {
	expiryDate: Date;
	isExpired: boolean;
} {
	const safeExpiry = expiryDate ?? new Date(0); // epoch as a sentinel (treat as expired)
	const now = Date.now();
	const isExpired = safeExpiry.getTime() <= now;
	return { expiryDate: safeExpiry, isExpired };
}

export function generateSecret(): `0x${string}` {
	const randomBytes = crypto.getRandomValues(new Uint8Array(32));
	return toHex(randomBytes);
}

export async function clearAllUserState(
	userId: string,
	threadId: string,
): Promise<void> {
	await Promise.all([
		clearAllUserFlows(userId),
		clearUserPendingCommand(userId),
	]);
}

// ===================== Name check =========================
/**
 * Check if a name is wrapped by checking if Registry owner is NameWrapper
 */
export async function isNameWrapped(name: string): Promise<boolean> {
	const client = getClient();
	const node = namehash(name);

	try {
		const registryOwner = (await client.readContract({
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
 * Get the ACTUAL owner of a .eth name
 *
 * For second-level .eth names (like alice.eth), we need to check:
 * 1. BaseRegistrar.ownerOf(tokenId) - this gives the "registrant"
 * 2. If registrant is NameWrapper, query NameWrapper.ownerOf(tokenId)
 *
 * For subdomains or wrapped names:
 * 1. Check ENS Registry owner
 * 2. If owner is NameWrapper, query NameWrapper.ownerOf(node)
 */
export async function getActualOwner(name: string): Promise<OwnerInfo> {
	const client = getClient();
	const isSecondLevel = name.split(".").length === 2 && name.endsWith(".eth");

	try {
		if (isSecondLevel) {
			// For second-level .eth names, use BaseRegistrar
			return await getSecondLevelOwner(client, name);
		} else {
			// For subdomains or other names, use Registry/NameWrapper
			return await getSubdomainOwner(client, name);
		}
	} catch (error) {
		console.error(`[getActualOwner] Error for ${name}:`, error);
		return {
			owner: null,
			isWrapped: false,
			error: `Failed to get owner: ${error}`,
		};
	}
}

/**
 * Get owner for second-level .eth names (e.g., alice.eth)
 */
async function getSecondLevelOwner(
	client: PublicClient,
	name: string,
): Promise<OwnerInfo> {
	const label = name.replace(/\.eth$/, "");
	const tokenId = getTokenId(label);

	try {
		// Get registrant from BaseRegistrar
		const registrant = (await client.readContract({
			address: ENS_CONTRACTS.BASE_REGISTRAR,
			abi: BASE_REGISTRAR_ABI,
			functionName: "ownerOf",
			args: [tokenId],
		})) as string;

		console.log(
			`[getSecondLevelOwner] ${name} BaseRegistrar owner: ${registrant}`,
		);

		if (registrant === zeroAddress) {
			return {
				owner: null,
				isWrapped: false,
				error: `${name} is not registered`,
			};
		}

		// Check if wrapped (registrant is NameWrapper)
		const isWrapped =
			registrant.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
		console.log(`[getSecondLevelOwner] ${name} isWrapped: ${isWrapped}`);

		if (isWrapped) {
			// Get actual owner from NameWrapper using the namehash as tokenId
			const node = namehash(name);
			const wrapperTokenId = BigInt(node);

			try {
				const wrapperOwner = (await client.readContract({
					address: NAME_WRAPPER_ADDRESS,
					abi: NAME_WRAPPER_ABI,
					functionName: "ownerOf",
					args: [wrapperTokenId],
				})) as string;

				console.log(
					`[getSecondLevelOwner] ${name} NameWrapper owner: ${wrapperOwner}`,
				);

				return {
					owner: wrapperOwner as `0x${string}`,
					isWrapped: true,
				};
			} catch (wrapperError) {
				console.error(
					`[getSecondLevelOwner] NameWrapper.ownerOf failed:`,
					wrapperError,
				);
				return {
					owner: null,
					isWrapped: true,
					error: `Failed to get owner from NameWrapper: ${wrapperError}`,
				};
			}
		}

		// Not wrapped - registrant is the actual owner
		return {
			owner: registrant as `0x${string}`,
			isWrapped: false,
		};
	} catch (error: any) {
		// ownerOf reverts for non-existent tokens
		if (
			error?.message?.includes("ERC721") ||
			error?.message?.includes("nonexistent")
		) {
			return {
				owner: null,
				isWrapped: false,
				error: `${name} is not registered`,
			};
		}
		throw error;
	}
}

/**
 * Get owner for subdomains (e.g., blog.alice.eth)
 */
async function getSubdomainOwner(
	client: PublicClient,
	name: string,
): Promise<OwnerInfo> {
	const node = namehash(name);

	// Check Registry owner
	const registryOwner = (await client.readContract({
		address: ENS_CONTRACTS.ENS_REGISTRY,
		abi: ENS_REGISTRY_ABI,
		functionName: "owner",
		args: [node as `0x${string}`],
	})) as string;

	console.log(`[getSubdomainOwner] ${name} Registry owner: ${registryOwner}`);

	if (registryOwner === zeroAddress) {
		return {
			owner: null,
			isWrapped: false,
			error: `${name} is not registered`,
		};
	}

	// Check if wrapped
	const isWrapped =
		registryOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
	console.log(`[getSubdomainOwner] ${name} isWrapped: ${isWrapped}`);

	if (isWrapped) {
		const wrapperTokenId = BigInt(node);

		try {
			const wrapperOwner = (await client.readContract({
				address: NAME_WRAPPER_ADDRESS,
				abi: NAME_WRAPPER_ABI,
				functionName: "ownerOf",
				args: [wrapperTokenId],
			})) as string;

			console.log(
				`[getSubdomainOwner] ${name} NameWrapper owner: ${wrapperOwner}`,
			);

			return {
				owner: wrapperOwner as `0x${string}`,
				isWrapped: true,
			};
		} catch (wrapperError) {
			console.error(
				`[getSubdomainOwner] NameWrapper.ownerOf failed:`,
				wrapperError,
			);
			return {
				owner: null,
				isWrapped: true,
				error: `Failed to get owner from NameWrapper: ${wrapperError}`,
			};
		}
	}

	return {
		owner: registryOwner as `0x${string}`,
		isWrapped: false,
	};
}

/**
 * Batch get actual owners for multiple names
 * More efficient than calling getActualOwner individually
 */
export async function getActualOwnersBatch(
	names: string[],
): Promise<Map<string, OwnerInfo>> {
	const client = getClient();
	const results = new Map<string, OwnerInfo>();

	// Separate second-level and subdomains
	const secondLevelNames: string[] = [];
	const subdomainNames: string[] = [];

	for (const name of names) {
		const isSecondLevel = name.split(".").length === 2 && name.endsWith(".eth");
		if (isSecondLevel) {
			secondLevelNames.push(name);
		} else {
			subdomainNames.push(name);
		}
	}

	// Process second-level names
	if (secondLevelNames.length > 0) {
		// Batch call BaseRegistrar.ownerOf for all
		const tokenIds = secondLevelNames.map((name) =>
			getTokenId(name.replace(/\.eth$/, "")),
		);

		const ownerCalls = tokenIds.map((tokenId) => ({
			address: ENS_CONTRACTS.BASE_REGISTRAR,
			abi: BASE_REGISTRAR_ABI,
			functionName: "ownerOf" as const,
			args: [tokenId] as const,
		}));

		const ownersResp = await client.multicall({
			contracts: ownerCalls,
			allowFailure: true,
		});

		// Find which ones are wrapped (owner is NameWrapper)
		const wrappedIndexes: number[] = [];

		ownersResp.forEach((r, i) => {
			const name = secondLevelNames[i];

			if (r.status !== "success") {
				results.set(name, {
					owner: null,
					isWrapped: false,
					error: `${name} is not registered`,
				});
				return;
			}

			const owner = r.result as string;
			if (owner === zeroAddress) {
				results.set(name, {
					owner: null,
					isWrapped: false,
					error: `${name} is not registered`,
				});
				return;
			}

			if (owner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
				wrappedIndexes.push(i);
			} else {
				results.set(name, {
					owner: owner as `0x${string}`,
					isWrapped: false,
				});
			}
		});

		// Batch call NameWrapper.ownerOf for wrapped names
		if (wrappedIndexes.length > 0) {
			const wrapperCalls = wrappedIndexes.map((i) => {
				const name = secondLevelNames[i];
				const node = namehash(name);
				return {
					address: NAME_WRAPPER_ADDRESS as `0x${string}`,
					abi: NAME_WRAPPER_ABI,
					functionName: "ownerOf" as const,
					args: [BigInt(node)] as const,
				};
			});

			const wrapperResp = await client.multicall({
				contracts: wrapperCalls,
				allowFailure: true,
			});

			wrapperResp.forEach((r, j) => {
				const originalIdx = wrappedIndexes[j];
				const name = secondLevelNames[originalIdx];

				if (r.status !== "success") {
					results.set(name, {
						owner: null,
						isWrapped: true,
						error: `Failed to get owner from NameWrapper`,
					});
					return;
				}

				results.set(name, {
					owner: r.result as `0x${string}`,
					isWrapped: true,
				});
			});
		}
	}

	// Process subdomains (less common, do individually for now)
	for (const name of subdomainNames) {
		const ownerInfo = await getSubdomainOwner(client, name);
		results.set(name, ownerInfo);
	}

	return results;
}

/**
 * Verify that one of the provided wallets owns the name
 */
export async function verifyOwnership(
	name: string,
	wallets: `0x${string}`[],
): Promise<{
	owned: boolean;
	ownerWallet?: `0x${string}`;
	isWrapped: boolean;
	actualOwner?: `0x${string}`;
	error?: string;
}> {
	const ownerInfo = await getActualOwner(name);

	if (!ownerInfo.owner) {
		return {
			owned: false,
			isWrapped: ownerInfo.isWrapped,
			error: ownerInfo.error || `${name} is not registered`,
		};
	}

	const ownerLower = ownerInfo.owner.toLowerCase();
	const matchingWallet = wallets.find((w) => w.toLowerCase() === ownerLower);

	if (matchingWallet) {
		return {
			owned: true,
			ownerWallet: matchingWallet,
			isWrapped: ownerInfo.isWrapped,
			actualOwner: ownerInfo.owner,
		};
	}

	return {
		owned: false,
		isWrapped: ownerInfo.isWrapped,
		actualOwner: ownerInfo.owner,
		error: `None of your wallets own ${name}. The owner is ${ownerInfo.owner}`,
	};
}
