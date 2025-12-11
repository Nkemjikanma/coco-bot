import { client } from "./redisClient";
import { RedisArgument } from "redis";
import { Session, Message } from "../types";

const SESSION_PREFIX = "session:";
const MAX_MESSAGES = 5; // Keep last 5 messages for context
const SESSION_TTL = 60 * 60 * 24; // 24 hours

export async function createSession(session: Session): Promise<void> {
  const key = (SESSION_PREFIX + session.threadId) as RedisArgument;

  await client.hSet(key, {
    threadId: session.threadId,
    userId: session.userId,
    lastMessageAt: session.lastMessageAt.toString(),
    messages: JSON.stringify(session.messages),
  });

  await client.expire(key, SESSION_TTL); // 24 hours
}

export async function getSessionByThreadId(
  threadId: string,
): Promise<Session | null> {
  const key = (SESSION_PREFIX + threadId) as RedisArgument;
  const data = await client.hGetAll(key);

  if (!data || Object.keys(data).length === 0) {
    return null;
  }

  return {
    threadId: data.threadId,
    userId: data.userId,
    lastMessageAt: Number(data.lastMessageAt),
    messages: JSON.parse(data.messages || "[]"),
  };
}

export async function updateSession(
  threadId: string,
  updates: Partial<Omit<Session, "threadId">>,
): Promise<Session> {
  const key = SESSION_PREFIX + threadId;
  const existing = await getSessionByThreadId(threadId);
  if (!existing) {
    throw new Error("Session not found");
  }

  const updated: Session = { ...existing, ...updates, threadId }; // ensure the threadId never changes

  await client.hSet(key, {
    threadId: updated.threadId,
    userId: updated.userId,
    lastMessageAt: updated.lastMessageAt.toString(),
    messages: JSON.stringify(updated.messages),
  });

  // Refresh TTL
  await client.expire(key, SESSION_TTL);

  return updated;
}

export async function deleteSession(id: string): Promise<void> {
  const key = SESSION_PREFIX + id;
  await client.del(key);
}

export async function appendMessageToSession(
  threadId: string,
  userId: string,
  message: Omit<Message, "userId">,
): Promise<Session> {
  const existing = await getSessionByThreadId(threadId);

  const fullMessage: Message = {
    ...message,
    userId,
  };

  if (!existing) {
    // create new session with first message
    const newSession: Session = {
      threadId,
      userId,
      lastMessageAt: message.timestamp,
      messages: [fullMessage],
    };

    await createSession(newSession);
    return newSession;
  }

  // append message and keep only last 5;
  const updatedMessages = [...existing.messages, fullMessage].slice(
    -MAX_MESSAGES,
  );

  return updateSession(threadId, {
    lastMessageAt: message.timestamp,
    messages: updatedMessages,
  });
}

/**
 * Get recent messages for context (for Claude)
 */
export async function getRecentMessages(
  threadId: string,
  limit: number = 5,
): Promise<Message[]> {
  const session = await getSessionByThreadId(threadId);

  if (!session) {
    return [];
  }

  return session.messages.slice(-limit);
}

/**
 * Check if session exists
 */
export async function sessionExists(threadId: string): Promise<boolean> {
  const key = SESSION_PREFIX + threadId;
  const exists = await client.exists(key);
  return exists === 1;
}

/**
 * Get all active sessions for a user (optional, useful for debugging)
 */
export async function getUserSessions(userId: string): Promise<Session[]> {
  const pattern = SESSION_PREFIX + "*";
  const keys = await client.keys(pattern);

  const sessions: Session[] = [];

  for (const key of keys) {
    const data = await client.hGetAll(key);
    if (data.userId === userId) {
      sessions.push({
        threadId: data.threadId,
        userId: data.userId,
        lastMessageAt: Number(data.lastMessageAt),
        messages: JSON.parse(data.messages || "[]"),
      });
    }
  }

  return sessions;
}

/**
 * Clear all expired sessions - Not sure when but if we need to
 */
export async function cleanupExpiredSessions(): Promise<number> {
  const pattern = SESSION_PREFIX + "*";
  const keys = await client.keys(pattern);

  const now = Date.now();
  let deleted = 0;

  for (const key of keys) {
    const ttl = await client.ttl(key);
    if (ttl === -1 || ttl === -2) {
      // No TTL or already expired
      await client.del(key);
      deleted++;
    }
  }

  return deleted;
}
