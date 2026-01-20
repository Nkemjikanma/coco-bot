import type { ParsedCommand, PendingCommand } from "../types";
import {
  clearActiveFlow,
  getActiveFlow,
  hasAnyActiveFlow,
  isRegistrationFlow,
  updateFlowData,
} from "./flow";
import { client } from "./redisClient";

export interface UserState {
  userId: string;

  // Where the user is currently active
  activeThreadId: string | null;
  activeChannelId: string | null;

  pendingCommand?: PendingCommand;

  // Timestamps
  lastActiveAt: number;
  createdAt: number;

  // User preferences
  preferences?: UserPreferences;
}

export interface UserPreferences {
  defaultDuration?: number; // Default registration years
  autoConfirm?: boolean; // Skip confirmation for small operations
  notificationsEnabled?: boolean;
}

const USER_STATE_PREFIX = "user:";
const USER_STATE_TTL = 60 * 60 * 24 * 7; // 7 days

export async function getUserState(userId: string): Promise<UserState | null> {
  const key = USER_STATE_PREFIX + userId;

  try {
    const data = await client.hGetAll(key);

    if (!data || Object.keys(data).length === 0) {
      return null;
    }

    return {
      userId: data.userId,
      activeThreadId: data.activeThreadId || null,
      activeChannelId: data.activeChannelId || null,
      pendingCommand: data.pendingCommand
        ? JSON.parse(data.pendingCommand)
        : undefined,
      lastActiveAt: Number(data.lastActiveAt) || Date.now(),
      createdAt: Number(data.createdAt) || Date.now(),
      preferences: data.preferences ? JSON.parse(data.preferences) : undefined,
    };
  } catch (error) {
    console.error("Error getting user state:", error);
    return null;
  }
}

export async function saveUserState(state: UserState): Promise<void> {
  const key = USER_STATE_PREFIX + state.userId;

  try {
    await client.hSet(key, {
      userId: state.userId,
      activeThreadId: state.activeThreadId || "",
      activeChannelId: state.activeChannelId || "",
      pendingCommand: state.pendingCommand
        ? JSON.stringify(state.pendingCommand)
        : "",
      lastActiveAt: state.lastActiveAt.toString(),
      createdAt: state.createdAt.toString(),
      preferences: state.preferences ? JSON.stringify(state.preferences) : "",
    });

    await client.expire(key, USER_STATE_TTL);
  } catch (error) {
    console.error("Error saving user state:", error);
  }
}

export async function updateUserLocation(
  userId: string,
  threadId: string,
  channelId: string,
): Promise<void> {
  const state = await getUserState(userId);

  if (state) {
    state.activeThreadId = threadId;
    state.activeChannelId = channelId;
    state.lastActiveAt = Date.now();
    await saveUserState(state);
  } else {
    // Create new user state
    await saveUserState({
      userId,
      activeThreadId: threadId,
      activeChannelId: channelId,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    });
  }
}

export async function setUserPendingCommand(
  userId: string,
  threadId: string,
  channelId: string,
  partial: Partial<ParsedCommand>,
  waitingFor: PendingCommand["waitingFor"],
): Promise<void> {
  const state = await getUserState(userId);

  const pendingCommand: PendingCommand = {
    partialCommand: partial,
    waitingFor,
    attemptCount: (state?.pendingCommand?.attemptCount || 0) + 1,
    createdAt: state?.pendingCommand?.createdAt || Date.now(),
  };

  if (state) {
    state.pendingCommand = pendingCommand;
    state.activeThreadId = threadId;
    state.activeChannelId = channelId;
    state.lastActiveAt = Date.now();
    await saveUserState(state);
  } else {
    await saveUserState({
      userId,
      activeThreadId: threadId,
      activeChannelId: channelId,
      pendingCommand,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    });
  }
}

export async function clearUserPendingCommand(userId: string): Promise<void> {
  const state = await getUserState(userId);

  if (state) {
    state.pendingCommand = undefined;
    state.lastActiveAt = Date.now();
    await saveUserState(state);
  }
}

export async function updateUserPreferences(
  userId: string,
  preferences: Partial<UserPreferences>,
): Promise<void> {
  const state = await getUserState(userId);

  if (state) {
    state.preferences = { ...state.preferences, ...preferences };
    state.lastActiveAt = Date.now();
    await saveUserState(state);
  } else {
    await saveUserState({
      userId,
      activeThreadId: null,
      activeChannelId: null,
      preferences,
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
    });
  }
}

export async function deleteUserState(userId: string): Promise<void> {
  const key = USER_STATE_PREFIX + userId;
  await client.del(key);
}

export function describePendingCommand(pending: PendingCommand): string {
  const { partialCommand, waitingFor } = pending;
  const action = partialCommand.action || "something";

  let description = `You were ${action}ing`;

  if ("names" in partialCommand && partialCommand.names) {
    description += ` **${partialCommand.names}**`;
  }

  if (waitingFor === "duration") {
    description += " (waiting for duration)";
  } else if (waitingFor === "name") {
    description += " (waiting for name)";
  } else if (waitingFor === "recipient") {
    description += " (waiting for recipient address)";
  } else if (waitingFor === "confirmation") {
    description += " (waiting for confirmation)";
  }

  return description;
}

// Registration (maps to flow store)
export async function getPendingRegistration(userId: string) {
  // For legacy code, we need to search all threads
  // This is less efficient but maintains compatibility
  const hasFlow = await hasAnyActiveFlow(userId);
  if (!hasFlow.hasFlow || hasFlow.type !== "registration") {
    return { success: false, error: "No pending registration found" };
  }

  const result = await getActiveFlow(userId, hasFlow.threadId!);
  if (!result.success || !isRegistrationFlow(result.data)) {
    return { success: false, error: "No pending registration found" };
  }

  return { success: true, data: result.data.data };
}

export async function setPendingRegistration(
  userId: string,
  registration: any,
) {
  // This needs threadId - legacy code should be updated
  console.warn(
    "setPendingRegistration is deprecated. Use setActiveFlow with createRegistrationFlow instead.",
  );
  return { success: false, error: "Use setActiveFlow instead" };
}

export async function updatePendingRegistration(userId: string, updates: any) {
  const hasFlow = await hasAnyActiveFlow(userId);
  if (!hasFlow.hasFlow || hasFlow.type !== "registration") {
    return { success: false, error: "No pending registration found" };
  }

  return updateFlowData(userId, hasFlow.threadId!, updates);
}

export async function clearPendingRegistration(userId: string) {
  const hasFlow = await hasAnyActiveFlow(userId);
  if (!hasFlow.hasFlow || hasFlow.type !== "registration") {
    return { success: true, data: undefined };
  }

  return clearActiveFlow(userId, hasFlow.threadId!);
}
