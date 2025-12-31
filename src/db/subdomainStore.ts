import {
  getActiveFlow,
  isSubdomainFlow,
  updateFlowData,
  clearActiveFlow,
} from "./flow";

// Subdomain (maps to flow store)
export async function getSubdomainState(userId: string, threadId: string) {
  const result = await getActiveFlow(userId, threadId);
  if (!result.success || !isSubdomainFlow(result.data)) {
    return { success: false, error: "No subdomain state found" };
  }
  return { success: true, data: result.data.data };
}

export async function setSubdomainState(
  userId: string,
  threadId: string,
  state: any,
) {
  console.warn(
    "setSubdomainState is deprecated. Use setActiveFlow with createSubdomainFlow instead.",
  );
  return { success: false, error: "Use setActiveFlow instead" };
}

export async function updateSubdomainState(
  userId: string,
  threadId: string,
  updates: any,
) {
  return updateFlowData(userId, threadId, updates);
}

export async function clearSubdomainState(userId: string, threadId: string) {
  const result = await getActiveFlow(userId, threadId);
  if (!result.success || !isSubdomainFlow(result.data)) {
    return { success: true };
  }
  return clearActiveFlow(userId, threadId);
}
