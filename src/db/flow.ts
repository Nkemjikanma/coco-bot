import { client } from "./redisClient";
import {
  RegistrationFlow,
  BridgeFlow,
  SubdomainFlow,
  FlowStatus,
  FlowType,
  ActiveFlow,
  TransferFlow,
} from "./flow.types";

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

// ============ Constants ============
const FLOW_PREFIX = "flow:";
export const FLOW_TTL = 60 * 30; // 30 minutes

// ============ Serialization ============
function serializeFlow(flow: ActiveFlow): string {
  return JSON.stringify(flow, (_, value) =>
    typeof value === "bigint" ? value.toString() + "n" : value,
  );
}

function deserializeFlow(json: string): ActiveFlow {
  return JSON.parse(json, (_, value) => {
    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });
}

// ============ Key Helpers ============
function getFlowKey(userId: string, threadId: string): string {
  return `${FLOW_PREFIX}${userId}:${threadId}`;
}

function getUserFlowPattern(userId: string): string {
  return `${FLOW_PREFIX}${userId}:*`;
}

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

    return { success: true, data: deserializeFlow(data) };
  } catch (error) {
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

  try {
    const serialized = serializeFlow(flow);
    await client.set(key, serialized, { EX: FLOW_TTL });
    return { success: true };
  } catch (error) {
    console.error("Error saving flow:", error);
    return { success: false, error: "Failed to save flow" };
  }
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
      const flow = deserializeFlow(data);
      return {
        hasFlow: true,
        threadId: flow.threadId,
        type: flow.type,
      };
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
