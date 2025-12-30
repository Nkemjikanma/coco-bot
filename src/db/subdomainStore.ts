import { SubdomainAssignmentState } from "../services/ens/subdomain/subdomain.types";
import { client } from "./redisClient";

const SUBDOMAIN_STATE_PREFIX = "subdomain:";
const SUBDOMAIN_STATE_TTL = 60 * 30; // 30 minutes

// ============ Serialization ============

function serializeSubdomainState(state: SubdomainAssignmentState): string {
  return JSON.stringify(state);
}

function deserializeSubdomainState(json: string): SubdomainAssignmentState {
  return JSON.parse(json);
}

// ============ CRUD Operations ============

export async function getSubdomainState(
  userId: string,
  threadId: string,
): Promise<{
  success: boolean;
  data?: SubdomainAssignmentState;
  error?: string;
}> {
  const key = `${SUBDOMAIN_STATE_PREFIX}${userId}:${threadId}`;

  try {
    const data = await client.get(key);

    if (!data) {
      return { success: false, error: "No subdomain state found" };
    }

    return {
      success: true,
      data: deserializeSubdomainState(data),
    };
  } catch (error) {
    console.error("Error getting subdomain state:", error);
    return { success: false, error: "Failed to retrieve subdomain state" };
  }
}

export async function setSubdomainState(
  userId: string,
  threadId: string,
  state: SubdomainAssignmentState,
): Promise<{ success: boolean; error?: string }> {
  const key = `${SUBDOMAIN_STATE_PREFIX}${userId}:${threadId}`;

  try {
    const serialized = serializeSubdomainState(state);
    await client.set(key, serialized, { EX: SUBDOMAIN_STATE_TTL });
    return { success: true };
  } catch (error) {
    console.error("Error saving subdomain state:", error);
    return { success: false, error: "Failed to save subdomain state" };
  }
}

export async function updateSubdomainState(
  userId: string,
  threadId: string,
  updates: Partial<SubdomainAssignmentState>,
): Promise<{
  success: boolean;
  data?: SubdomainAssignmentState;
  error?: string;
}> {
  const existingResult = await getSubdomainState(userId, threadId);

  if (!existingResult.success || !existingResult.data) {
    return { success: false, error: existingResult.error || "State not found" };
  }

  const updated: SubdomainAssignmentState = {
    ...existingResult.data,
    ...updates,
  };

  const saveResult = await setSubdomainState(userId, threadId, updated);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error };
  }

  return { success: true, data: updated };
}

export async function clearSubdomainState(
  userId: string,
  threadId: string,
): Promise<{ success: boolean; error?: string }> {
  const key = `${SUBDOMAIN_STATE_PREFIX}${userId}:${threadId}`;

  try {
    await client.del(key);
    return { success: true };
  } catch (error) {
    console.error("Error clearing subdomain state:", error);
    return { success: false, error: "Failed to clear subdomain state" };
  }
}
