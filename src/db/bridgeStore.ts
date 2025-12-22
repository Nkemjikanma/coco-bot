import { client } from "./redisClient";
import { BridgeState } from "../services/bridge";
import { ApiResponse } from "../api";
import { success } from "zod";

const PENDING_BRIDGE_PREFIX = "bridge:";
const PENDING_BRIDGE_TTL = 60 * 30; // 30 minutes

function serializeBridge(bridge: BridgeState): string {
  return JSON.stringify(bridge, (_, value) =>
    typeof value === "bigint" ? value.toString() + "n" : value,
  );
}

function deserializeBridge(json: string): BridgeState {
  return JSON.parse(json, (_, value) => {
    if (typeof value === "string" && /^\d+n$/.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    return value;
  });
}

export async function getBridgeState(
  userId: string,
  threadId: string,
): Promise<ApiResponse<BridgeState>> {
  const key = `${PENDING_BRIDGE_PREFIX}${userId}${threadId}`;

  try {
    const data = await client.get(key);

    if (!data) {
      return { success: false, error: "No bridge found" };
    }

    return {
      success: true,
      data: deserializeBridge(data),
    };
  } catch (error) {
    console.error("Error getting bridges:", error);

    return { success: false, error: "Failed to retrieve bridge" };
  }
}

export async function setBridgeState(
  userId: string,
  threadId: string,
  bridge: BridgeState,
): Promise<ApiResponse<void>> {
  const key = `${PENDING_BRIDGE_PREFIX}${userId}${threadId}`;

  try {
    const serialized = serializeBridge(bridge);
    await client.set(key, serialized, { EX: PENDING_BRIDGE_TTL });
    return { success: true, data: undefined };
  } catch (error) {
    console.error("Error saving bridge state:", error);
    return { success: false, error: "Failed to save bridge state data" };
  }
}

export async function updateBridgeState(
  userId: string,
  threadId: string,
  updates: Partial<BridgeState>,
): Promise<ApiResponse<BridgeState>> {
  const existingResult = await getBridgeState(userId, threadId);

  if (!existingResult.success) {
    return existingResult;
  }

  const updated = {
    ...existingResult.data,
    ...updates,
  } as BridgeState;

  const saveResult = await setBridgeState(userId, threadId, updated);

  if (!saveResult.success) {
    return saveResult;
  }

  return { success: true, data: updated };
}

export async function clearBridge(
  userId: string,
  threadId: string,
): Promise<ApiResponse<void>> {
  const key = `${PENDING_BRIDGE_PREFIX}${userId}${threadId}`;

  try {
    await client.del(key);
    return { success: true, data: undefined };
  } catch (error) {
    console.error("Error clearing bridge", error);
    return { success: false, error: "Failed to clear bridge" };
  }
}
