import type { RedisArgument } from "redis";
import type { Message, Session } from "../types";
import { client } from "./redisClient";

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
