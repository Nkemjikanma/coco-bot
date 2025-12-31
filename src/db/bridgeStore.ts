import {
  getActiveFlow,
  isBridgeFlow,
  updateFlowData,
  clearActiveFlow,
} from "./flow";

// Bridge (maps to flow store)
export async function getBridgeState(userId: string, threadId: string) {
  const result = await getActiveFlow(userId, threadId);
  if (!result.success || !isBridgeFlow(result.data)) {
    return { success: false, error: "No bridge found" };
  }
  return { success: true, data: result.data.data };
}

export async function setBridgeState(
  userId: string,
  threadId: string,
  bridge: any,
) {
  console.warn(
    "setBridgeState is deprecated. Use setActiveFlow with createBridgeFlow instead.",
  );
  return { success: false, error: "Use setActiveFlow instead" };
}

export async function updateBridgeState(
  userId: string,
  threadId: string,
  updates: any,
) {
  return updateFlowData(userId, threadId, updates);
}

export async function clearBridge(userId: string, threadId: string) {
  const result = await getActiveFlow(userId, threadId);
  if (!result.success || !isBridgeFlow(result.data)) {
    return { success: true, data: undefined };
  }
  return clearActiveFlow(userId, threadId);
}
