import { client } from "./redisClient";
import { ConversationState, PendingCommand, ParsedCommand } from "../types";

const CONVERSATION_PREFIX = "converstation:";
const CONVERSATION_TTL = 60 * 10; // 10 mins for pending commands

// Store conversations state(pending commands and user prefs)
export async function saveConversationState(
  state: ConversationState,
): Promise<void> {
  const key = CONVERSATION_PREFIX + state.threadId;

  await client.hSet(key, {
    threadId: state.threadId,
    userId: state.userId,
    pendingCommand: state.pendingCommand
      ? JSON.stringify(state.pendingCommand)
      : "",
    lastBotQuestion: state.lastBotQuestion || "",
    userPreferences: state.userPreferences
      ? JSON.stringify(state.userPreferences)
      : "",
  });

  await client.expire(key, CONVERSATION_TTL);
}

// get conversation state
export async function getConversationState(
  threadId: string,
): Promise<ConversationState | null> {
  const key = CONVERSATION_PREFIX + threadId;

  const data = await client.hGetAll(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    threadId: data.threadId,
    userId: data.userId,
    pendingCommand: data.pendingCommand
      ? JSON.parse(data.pendingCommand)
      : undefined,
    lastBotQuestion: data.lastBotQuestion || undefined,
    userPreferences: data.userPreferences
      ? JSON.parse(data.userPreferences)
      : undefined,
  };
}

// clear pending command after execution or timeout
export async function clearPendingCommand(threadId: string): Promise<void> {
  const state = await getConversationState(threadId);
  if (!state) return;

  state.pendingCommand = undefined;
  await saveConversationState(state);
}

// set pending command - waiting for user input
export async function setPendingCommand(
  threadId: string,
  userId: string,
  partial: Partial<ParsedCommand>,
  waitingFor: PendingCommand["waitingFor"],
): Promise<void> {
  const state = (await getConversationState(threadId)) || { threadId, userId };

  state.pendingCommand = {
    partialCommand: partial,
    waitingFor,
    attemptCount: (state.pendingCommand?.attemptCount || 0) + 1,
    createdAt: Date.now(),
  };

  await saveConversationState(state);
}
