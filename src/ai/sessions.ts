// src/agent/sessions.ts

import { randomUUID } from "crypto";
import { client } from "../db/redisClient";
import type { AgentMessage, AgentSession, AgentSessionStatus } from "./types";

const SESSION_PREFIX = "agent:session:";
const SESSION_TTL = 60 * 30; // 30 minutes

/**
 * Generate session key
 */
function getSessionKey(userId: string, threadId: string): string {
	return `${SESSION_PREFIX}${userId}:${threadId}`;
}

/**
 * Create a new agent session
 */
export async function createAgentSession(
	userId: string,
	threadId: string,
	channelId: string,
): Promise<AgentSession> {
	const session: AgentSession = {
		sessionId: randomUUID(),
		userId,
		threadId,
		channelId,
		status: "active",
		messages: [],
		startedAt: Date.now(),
		lastActivityAt: Date.now(),
		turnCount: 0,
		estimatedCost: 0,
	};

	await saveSession(session);
	return session;
}

/**
 * Get existing session or create new one
 */
export async function getOrCreateSession(
	userId: string,
	threadId: string,
	channelId: string,
): Promise<AgentSession> {
	const existing = await getSession(userId, threadId);

	if (
		existing &&
		existing.status !== "complete" &&
		existing.status !== "error"
	) {
		// Update last activity
		existing.lastActivityAt = Date.now();
		await saveSession(existing);
		return existing;
	}

	return createAgentSession(userId, threadId, channelId);
}

/**
 * Get session by user and thread
 */
export async function getSession(
	userId: string,
	threadId: string,
): Promise<AgentSession | null> {
	const key = getSessionKey(userId, threadId);

	try {
		const data = await client.get(key);
		if (!data) return null;

		return JSON.parse(data) as AgentSession;
	} catch (error) {
		console.error("Error getting agent session:", error);
		return null;
	}
}

/**
 * Save session to Redis
 */
export async function saveSession(session: AgentSession): Promise<void> {
	const key = getSessionKey(session.userId, session.threadId);

	try {
		await client.set(key, JSON.stringify(session), { EX: SESSION_TTL });
	} catch (error) {
		console.error("Error saving agent session:", error);
	}
}

/**
 * Update session status
 */
export async function updateSessionStatus(
	userId: string,
	threadId: string,
	status: AgentSessionStatus,
): Promise<void> {
	const session = await getSession(userId, threadId);
	if (!session) return;

	session.status = status;
	session.lastActivityAt = Date.now();
	await saveSession(session);
}

/**
 * Update session with pending tool call (for resuming after user action)
 */
export async function setSessionPendingAction(
	userId: string,
	threadId: string,
	pendingToolCall: AgentSession["pendingToolCall"],
	currentAction: AgentSession["currentAction"],
): Promise<void> {
	const session = await getSession(userId, threadId);
	if (!session) return;

	session.pendingToolCall = pendingToolCall;
	session.currentAction = currentAction;
	session.status = "awaiting_signature";
	session.lastActivityAt = Date.now();
	await saveSession(session);
}

/**
 * Clear pending action after user completes it
 */
export async function clearSessionPendingAction(
	userId: string,
	threadId: string,
): Promise<AgentSession | null> {
	const session = await getSession(userId, threadId);
	if (!session) return null;

	session.pendingToolCall = undefined;
	session.status = "active";
	session.lastActivityAt = Date.now();
	await saveSession(session);

	return session;
}

/**
 * Add message to session history
 */
export async function addSessionMessage(
	userId: string,
	threadId: string,
	message: Omit<AgentMessage, "timestamp">,
): Promise<void> {
	const session = await getSession(userId, threadId);
	if (!session) return;

	session.messages.push({
		...message,
		timestamp: Date.now(),
	});

	// Keep only last 20 messages to avoid bloat
	if (session.messages.length > 20) {
		session.messages = session.messages.slice(-20);
	}

	session.lastActivityAt = Date.now();
	await saveSession(session);
}

/**
 * Increment turn count
 */
export async function incrementTurnCount(
	userId: string,
	threadId: string,
): Promise<void> {
	const session = await getSession(userId, threadId);
	if (!session) return;

	session.turnCount += 1;
	session.lastActivityAt = Date.now();
	await saveSession(session);
}

/**
 * Update estimated cost
 */
export async function updateSessionCost(
	userId: string,
	threadId: string,
	costUsd: number,
): Promise<void> {
	const session = await getSession(userId, threadId);
	if (!session) return;

	session.estimatedCost += costUsd;
	session.lastActivityAt = Date.now();
	await saveSession(session);
}

/**
 * Clear session (delete from Redis)
 */
export async function clearSession(
	userId: string,
	threadId: string,
): Promise<void> {
	const key = getSessionKey(userId, threadId);

	try {
		await client.del(key);
	} catch (error) {
		console.error("Error clearing agent session:", error);
	}
}

/**
 * Check if session is awaiting user action
 */
export async function isAwaitingUserAction(
	userId: string,
	threadId: string,
): Promise<boolean> {
	const session = await getSession(userId, threadId);
	if (!session) return false;

	return (
		session.status === "awaiting_signature" ||
		session.status === "awaiting_confirmation"
	);
}
