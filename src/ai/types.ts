import type { BotHandler } from "@towns-protocol/bot";

export interface AgentConfig {
	model: string;
	maxTurns: number;
	maxTokens: number;
}

export interface AgentRunResult {
	success: boolean;
	status: "complete" | "awaiting_action" | "error" | "max_turns";
	message?: string;
	error?: string;
	session: AgentSession;
}

export interface AgentContext {
	// User & location
	userId: string;
	channelId: string;
	threadId: string;

	// Towns handler for sending messages/transactions
	handler: BotHandler;

	// Session tracking
	sessionId: string;

	// Helper methods
	sendMessage: (message: string) => Promise<void>;
	sendTransaction: (tx: TransactionRequest) => Promise<void>;
}

/**
 * Transaction request to send to user
 */
export interface TransactionRequest {
	id: string;
	title: string;
	chainId: string;
	to: `0x${string}`;
	value: string;
	data: `0x${string}`;
	signerWallet: `0x${string}`;
}

/**
 * Agent session stored in Redis
 */
export interface AgentSession {
	sessionId: string;
	userId: string;
	threadId: string;
	channelId: string;

	// State
	status: AgentSessionStatus;

	// Current action being performed
	currentAction?: {
		type: AgentActionType;
		step: number;
		totalSteps: number;
		data: Record<string, unknown>;
	};

	// For resuming after user action
	pendingToolCall?: {
		toolName: string;
		toolId: string;
		expectedAction: string;
	};

	// Conversation history for context
	messages: AgentMessage[];

	// Metrics
	startedAt: number;
	lastActivityAt: number;
	turnCount: number;
	estimatedCost: number;
}

export type AgentSessionStatus =
	| "active"
	| "awaiting_confirmation"
	| "awaiting_signature"
	| "waiting_period" // e.g., 60s wait for registration
	| "complete"
	| "error"
	| "timeout";

export type AgentActionType =
	| "registration"
	| "renewal"
	| "transfer"
	| "subdomain"
	| "bridge"
	| "set_primary";

export interface AgentMessage {
	role: "user" | "assistant" | "tool_result";
	content: string;
	timestamp: number;
	toolName?: string;
	toolId?: string;
}

/**
 * Result from a tool execution
 */
export interface ToolResult {
	success: boolean;
	data?: unknown;
	error?: string;

	// For tools that need user action
	requiresUserAction?: boolean;
	userAction?: {
		type: "sign_transaction" | "confirm" | "provide_input";
		payload: unknown;
	};

	// For display
	displayMessage?: string;
}

/**
 * Tool definition following Agent SDK pattern
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<
			string,
			{
				type: string;
				description: string;
				enum?: string[];
			}
		>;
		required: string[];
	};
	execute: (
		params: Record<string, unknown>,
		context: AgentContext,
	) => Promise<ToolResult>;
}
