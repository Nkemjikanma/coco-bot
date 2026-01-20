import { createHmac, timingSafeEqual } from "crypto";
import type {
	ActiveFlow,
	BridgeFlow,
	FlowStatus,
	FlowType,
	RegistrationFlow,
	RenewFlow,
	SubdomainFlow,
	TransferFlow,
} from "./flow.types";
import { client } from "./redisClient";

export function isRegistrationFlow(flow: ActiveFlow): flow is RegistrationFlow {
	return flow.type === "registration";
}

export function isBridgeFlow(flow: ActiveFlow): flow is BridgeFlow {
	return flow.type === "bridge";
}

export function isSubdomainFlow(flow: ActiveFlow): flow is SubdomainFlow {
	return flow.type === "subdomain";
}

export function isTransferFlow(flow: ActiveFlow): flow is TransferFlow {
	return flow.type === "transfer";
}

export function isRenewFlow(flow: ActiveFlow): flow is RenewFlow {
	return flow.type === "renew";
}

// ============ Constants ============
const INTEGRITY_SECRET = process.env.REDIS_INTEGRITY_SECRET;
const FLOW_PREFIX = "flow:";
export const FLOW_TTL = 60 * 30; // 30 minutes
const MAX_DATA_AGE_MS = 30 * 60 * 1000;

if (!INTEGRITY_SECRET || INTEGRITY_SECRET.length < 32) {
	console.error(
		"⚠️ WARNING: REDIS_INTEGRITY_SECRET is not set or too short (min 32 chars).",
		"Flow data integrity checks will be DISABLED. This is insecure for production!",
	);
}

/**
 * Generate Redis key for a user's flow in a specific thread
 */
function getFlowKey(userId: string, threadId: string): string {
	return `${FLOW_PREFIX}${userId}:${threadId}`;
}

/**
 * Generate Redis pattern to match all flows for a user
 */
function getUserFlowPattern(userId: string): string {
	return `${FLOW_PREFIX}${userId}:*`;
}

// ============================================================
// HMAC UTILITIES
// ============================================================

interface SecurePayload<T> {
	d: T; // data
	s: string; // signature
	t: number; // timestamp
	v: number; // version (for future migrations)
}
function generateHMAC(data: string): string {
	if (!INTEGRITY_SECRET) {
		// Return empty signature if no secret (insecure mode)
		return "";
	}
	return createHmac("sha256", INTEGRITY_SECRET).update(data).digest("hex");
}

function verifyHMAC(data: string, signature: string): boolean {
	if (!INTEGRITY_SECRET) {
		// Skip verification if no secret (insecure mode)
		console.warn("⚠️ Skipping HMAC verification - no INTEGRITY_SECRET set");
		return true;
	}

	const expected = generateHMAC(data);

	// Handle empty signatures (from insecure mode)
	if (!signature || !expected) {
		return !signature && !expected;
	}

	// Convert to buffers for timing-safe comparison
	const expectedBuffer = Buffer.from(expected, "hex");
	const signatureBuffer = Buffer.from(signature, "hex");

	if (expectedBuffer.length !== signatureBuffer.length) {
		return false;
	}

	return timingSafeEqual(expectedBuffer, signatureBuffer);
}

// ============ BigInt-Safe Stringify/Parse ============

const bigIntReplacer = (_: string, value: unknown) =>
	typeof value === "bigint" ? `${value.toString()}n` : value;

const bigIntReviver = (_: string, value: unknown) =>
	typeof value === "string" && /^\d+n$/.test(value)
		? BigInt(value.slice(0, -1))
		: value;

const safeStringify = (data: unknown) => JSON.stringify(data, bigIntReplacer);
const safeParse = <T>(json: string) => JSON.parse(json, bigIntReviver) as T;

// ============ Serialization ============
function serializeFlow<T>(data: T): string {
	const timestamp = Date.now();
	const jsonData = safeStringify(data); // ✅ Use safe stringify

	// Sign: data + timestamp
	const toSign = `${jsonData}|${timestamp}`;
	const signature = generateHMAC(toSign);

	const payload: SecurePayload<T> = {
		d: data,
		s: signature,
		t: timestamp,
		v: 1,
	};

	return safeStringify(payload); // ✅ Use safe stringify
}

function deserializeFlow<T>(
	serialized: string,
	options: { maxAgeMs?: number } = {},
): T {
	const { maxAgeMs = MAX_DATA_AGE_MS } = options;

	let payload: SecurePayload<T>;
	try {
		payload = safeParse<SecurePayload<T>>(serialized); // ✅ Use safe parse
	} catch {
		throw new Error("DATA_INTEGRITY_VIOLATION: Invalid payload format");
	}

	const { d: data, s: signature, t: timestamp, v: version } = payload;

	if (version !== 1) {
		throw new Error(`DATA_INTEGRITY_VIOLATION: Unknown version ${version}`);
	}

	// Reconstruct signed data - MUST match serialization!
	const jsonData = safeStringify(data); // ✅ Use safe stringify (same as serialize)
	const toVerify = `${jsonData}|${timestamp}`;

	if (!verifyHMAC(toVerify, signature)) {
		throw new Error(
			"DATA_INTEGRITY_VIOLATION: Signature mismatch - data tampered",
		);
	}

	const age = Date.now() - timestamp;
	if (age > maxAgeMs) {
		throw new Error(
			`DATA_EXPIRED: Data is ${Math.round(age / 1000)}s old (max: ${maxAgeMs / 1000}s)`,
		);
	}

	if (age < 0) {
		throw new Error("DATA_INTEGRITY_VIOLATION: Future timestamp detected");
	}

	return data;
}

// ============================================================
// SECURITY LOGGING
// ============================================================

function logSecurityIncident(
	type: "tampering" | "expired" | "invalid",
	details: Record<string, unknown>,
): void {
	console.error(`🚨 SECURITY INCIDENT [${type.toUpperCase()}]`, {
		timestamp: new Date().toISOString(),
		...details,
	});

	// Tracing?
	// - Send to monitoring service? (DataDog, Sentry, etc.)
	// - Rate limit the affected user
}

// ============================================================
// SECURE FLOW STORE FUNCTIONS
// ============================================================

export async function setSecureFlow<T>(
	key: string,
	data: T,
	ttlSeconds: number = FLOW_TTL,
): Promise<{ success: boolean; error?: string }> {
	try {
		const serialized = serializeFlow(data);
		await client.set(key, serialized, { EX: ttlSeconds });
		return { success: true };
	} catch (error) {
		console.error("Error saving secure flow:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

export async function getSecureFlow<T>(
	key: string,
): Promise<{ success: boolean; data?: T; error?: string }> {
	try {
		const serialized = await client.get(key);

		if (!serialized) {
			return { success: false, error: "Not found" };
		}

		const data = deserializeFlow<T>(serialized);
		return { success: true, data };
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes("INTEGRITY_VIOLATION")) {
				logSecurityIncident("tampering", { key, error: error.message });
				return { success: false, error: "Security violation" };
			}
			if (error.message.includes("DATA_EXPIRED")) {
				logSecurityIncident("expired", { key, error: error.message });
				return { success: false, error: "Data expired" };
			}
		}

		console.error("Error getting secure flow:", error);
		return { success: false, error: "Failed to retrieve" };
	}
}

// ============================================================
// FLOW CRUD OPERATIONS
// ============================================================

/**
 * Get active flow for a user in a specific thread
 */
export async function getActiveFlow(
	userId: string,
	threadId: string,
): Promise<
	{ success: true; data: ActiveFlow } | { success: false; error: string }
> {
	const key = getFlowKey(userId, threadId);

	try {
		const data = await client.get(key);

		if (!data) {
			return { success: false, error: "No active flow found" };
		}

		const flow = deserializeFlow<ActiveFlow>(data);
		return { success: true, data: flow };
	} catch (error) {
		if (error instanceof Error) {
			if (error.message.includes("INTEGRITY_VIOLATION")) {
				logSecurityIncident("tampering", {
					userId,
					threadId,
					error: error.message,
				});
				return { success: false, error: "Security violation detected" };
			}
			if (error.message.includes("DATA_EXPIRED")) {
				// Clean up expired flow
				await client.del(key);
				return { success: false, error: "Flow expired" };
			}
		}
		console.error("Error getting active flow:", error);
		return { success: false, error: "Failed to retrieve flow" };
	}
}

/**
 * Set/create an active flow
 */
export async function setActiveFlow(
	flow: ActiveFlow,
): Promise<{ success: boolean; error?: string }> {
	const key = getFlowKey(flow.userId, flow.threadId);
	return setSecureFlow(key, flow);
}

/**
 * Update an existing flow
 */
export async function updateActiveFlow<T extends ActiveFlow>(
	userId: string,
	threadId: string,
	updates: Partial<Omit<T, "userId" | "threadId" | "type" | "startedAt">>,
): Promise<
	{ success: true; data: ActiveFlow } | { success: false; error: string }
> {
	const existingResult = await getActiveFlow(userId, threadId);

	if (!existingResult.success) {
		return existingResult;
	}

	const updated: ActiveFlow = {
		...existingResult.data,
		...updates,
		updatedAt: Date.now(),
	} as ActiveFlow;

	const saveResult = await setActiveFlow(updated);

	if (!saveResult.success) {
		return {
			success: false,
			error: saveResult.error || "Failed to update flow",
		};
	}

	return { success: true, data: updated };
}

/**
 * Update just the flow data (type-safe helper)
 */
export async function updateFlowData<T extends ActiveFlow>(
	userId: string,
	threadId: string,
	dataUpdates: Partial<T["data"]>,
): Promise<
	{ success: true; data: ActiveFlow } | { success: false; error: string }
> {
	const existingResult = await getActiveFlow(userId, threadId);

	if (!existingResult.success) {
		return existingResult;
	}

	const updated: ActiveFlow = {
		...existingResult.data,
		data: {
			...existingResult.data.data,
			...dataUpdates,
		},
		updatedAt: Date.now(),
	} as ActiveFlow;

	const saveResult = await setActiveFlow(updated);

	if (!saveResult.success) {
		return {
			success: false,
			error: saveResult.error || "Failed to update flow",
		};
	}

	return { success: true, data: updated };
}

/**
 * Update flow status
 */
export async function updateFlowStatus(
	userId: string,
	threadId: string,
	status: FlowStatus,
): Promise<
	{ success: true; data: ActiveFlow } | { success: false; error: string }
> {
	return updateActiveFlow(userId, threadId, { status });
}

/**
 * Clear/delete an active flow
 */
export async function clearActiveFlow(
	userId: string,
	threadId: string,
): Promise<{ success: boolean; error?: string }> {
	const key = getFlowKey(userId, threadId);

	try {
		await client.del(key);
		return { success: true };
	} catch (error) {
		console.error("Error clearing flow:", error);
		return { success: false, error: "Failed to clear flow" };
	}
}

/**
 * Check if user has ANY active flow (in any thread)
 */
export async function hasAnyActiveFlow(
	userId: string,
): Promise<{ hasFlow: boolean; threadId?: string; type?: FlowType }> {
	const pattern = getUserFlowPattern(userId);

	try {
		const keys = await client.keys(pattern);

		if (keys.length === 0) {
			return { hasFlow: false };
		}

		// Get the first one to return details
		const firstKey = keys[0];
		const data = await client.get(firstKey);

		if (data) {
			try {
				const flow = deserializeFlow<ActiveFlow>(data);
				return {
					hasFlow: true,
					threadId: flow.threadId,
					type: flow.type,
				};
			} catch (error) {
				// If deserialization fails (tampered/expired), clean up and report no flow
				if (error instanceof Error) {
					if (error.message.includes("INTEGRITY_VIOLATION")) {
						logSecurityIncident("tampering", { userId, key: firstKey });
					}
					// Clean up the bad entry
					await client.del(firstKey);
				}
				return { hasFlow: false };
			}
		}

		return { hasFlow: false };
	} catch (error) {
		console.error("Error checking for active flows:", error);
		return { hasFlow: false };
	}
}

/**
 * Clear ALL flows for a user (useful for cleanup)
 */
export async function clearAllUserFlows(
	userId: string,
): Promise<{ success: boolean; cleared: number }> {
	const pattern = getUserFlowPattern(userId);

	try {
		const keys = await client.keys(pattern);

		if (keys.length > 0) {
			await client.del(keys);
		}

		return { success: true, cleared: keys.length };
	} catch (error) {
		console.error("Error clearing user flows:", error);
		return { success: false, cleared: 0 };
	}
}
