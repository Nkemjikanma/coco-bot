import Anthropic from "@anthropic-ai/sdk";
import type { BotHandler } from "@towns-protocol/bot";
import { metrics } from "../services/metrics/metrics";
import { COCO_SYSTEM_PROMPT, COCO_TOOL_GUIDELINES } from "./prompts";
import {
  addSessionMessage,
  clearSessionPendingAction,
  getOrCreateSession,
  getSession,
  incrementTurnCount,
  updateSessionCost,
  updateSessionStatus,
} from "./sessions";
import { getTool, toAnthropicTools } from "./tools";
import type {
  AgentConfig,
  AgentContext,
  AgentRunResult,
  AgentSession,
  TransactionRequest,
} from "./types";

const DEFAULT_CONFIG: AgentConfig = {
  model: "claude-sonnet-4-20250514",
  maxTurns: 25,
  maxTokens: 4096,
};

export class CocoAgent {
  private client: Anthropic;
  private config: AgentConfig;

  constructor(config: Partial<AgentConfig> = {}) {
    this.client = new Anthropic();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main entry point - run the agent for a user message
   */
  async run(
    message: string,
    handler: BotHandler,
    userId: string,
    channelId: string,
    threadId: string,
  ): Promise<AgentRunResult> {
    // Validate message is not empty
    if (!message || !message.trim()) {
      console.log(`[CocoAgent] Skipping empty message`);
      return {
        success: false,
        status: "error",
        error: "Empty message",
        session: {} as AgentSession,
      };
    }

    // Get or create session
    const session = await getOrCreateSession(userId, threadId, channelId);

    console.log(`[CocoAgent] Starting run for session ${session.sessionId}`);
    console.log(`[CocoAgent] User message: "${message}"`);

    // Track session start
    if (session.turnCount === 0) {
      await metrics.trackEvent("agent_session_started" as any, {
        userId,
        sessionId: session.sessionId,
      });
    }

    // Create context for tools
    const context = createAgentContext(
      handler,
      userId,
      channelId,
      threadId,
      session.sessionId,
    );

    // Add user message to session
    await addSessionMessage(userId, threadId, {
      role: "user",
      content: message,
    });

    try {
      // Build conversation messages
      const messages = this.buildMessages(session, message);

      // Ensure we have at least one message
      if (messages.length === 0) {
        messages.push({ role: "user", content: message });
      }

      // Run agent loop
      const result = await this.agentLoop(messages, context, session);

      return result;
    } catch (error) {
      console.error("[CocoAgent] Error:", error);

      await updateSessionStatus(userId, threadId, "error");

      await metrics.trackEvent("error_occurred", {
        userId,
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return {
        success: false,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
        session,
      };
    }
  }

  /**
   * Resume agent after user action (transaction signed, confirmation, etc.)
   */
  async resume(
    handler: BotHandler,
    userId: string,
    channelId: string,
    threadId: string,
    actionResult: {
      type: "transaction" | "confirmation";
      success: boolean;
      data?: Record<string, unknown>;
    },
  ): Promise<AgentRunResult> {
    const session = await getSession(userId, threadId);

    if (!session) {
      return {
        success: false,
        status: "error",
        error: "No active session found",
        session: {} as AgentSession,
      };
    }

    console.log(`[CocoAgent] Resuming session ${session.sessionId}`);
    console.log(`[CocoAgent] Action result:`, actionResult);

    const context = createAgentContext(
      handler,
      userId,
      channelId,
      threadId,
      session.sessionId,
    );

    // Store the pending tool info before clearing
    const pendingToolName = session.pendingToolCall?.toolName || "";

    // Create a user message describing what happened
    // This is simpler and more reliable than trying to reconstruct tool_result blocks
    let userMessage: string;
    if (actionResult.type === "confirmation") {
      userMessage = actionResult.success
        ? "I confirm. Please proceed."
        : "I cancel. Do not proceed.";
    } else {
      // Transaction
      userMessage = actionResult.success
        ? `Transaction successful. Hash: ${actionResult.data?.txHash}`
        : "Transaction was rejected/cancelled.";
    }

    // Add as a regular user message
    await addSessionMessage(userId, threadId, {
      role: "user",
      content: userMessage,
    });

    // IMPORTANT: Clear the pending action so new messages aren't blocked
    await clearSessionPendingAction(userId, threadId);

    // Build messages with the new user message (NOT as tool_result)
    const messages = this.buildMessages(session, userMessage);

    // Continue agent loop
    return this.agentLoop(messages, context, session);
  }

  /**
   * Main agent loop - calls Claude and handles tool use
   */
  private async agentLoop(
    messages: Anthropic.MessageParam[],
    context: AgentContext,
    session: AgentSession,
  ): Promise<AgentRunResult> {
    let turnCount = 0;

    while (turnCount < this.config.maxTurns) {
      turnCount++;
      await incrementTurnCount(context.userId, context.threadId);

      console.log(`[CocoAgent] Turn ${turnCount}/${this.config.maxTurns}`);

      // Call Claude
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: `${COCO_SYSTEM_PROMPT}\n\n${COCO_TOOL_GUIDELINES}`,
        tools: toAnthropicTools(),
        messages,
      });

      // Track cost (approximate)
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const costUsd = (inputTokens * 0.003 + outputTokens * 0.015) / 1000;
      await updateSessionCost(context.userId, context.threadId, costUsd);

      console.log(`[CocoAgent] Response stop_reason: ${response.stop_reason}`);
      console.log(
        `[CocoAgent] Response content blocks: ${response.content.length}`,
      );

      // Process response
      const textBlocks: string[] = [];
      const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          console.log(
            `[CocoAgent] Text block: "${block.text.substring(0, 100)}..."`,
          );
          textBlocks.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseBlocks.push(block);
        }
      }

      console.log(
        `[CocoAgent] Text blocks: ${textBlocks.length}, Tool blocks: ${toolUseBlocks.length}`,
      );

      // Send any text responses to user
      if (textBlocks.length > 0) {
        const text = textBlocks.join("\n");
        if (text.trim()) {
          console.log(
            `[CocoAgent] Sending message to user: "${text.substring(0, 100)}..."`,
          );
          try {
            await context.sendMessage(text);
            console.log(`[CocoAgent] Message sent successfully`);
          } catch (sendError) {
            console.error(`[CocoAgent] ERROR sending message:`, sendError);
          }
          await addSessionMessage(context.userId, context.threadId, {
            role: "assistant",
            content: text,
          });
        } else {
          console.log(`[CocoAgent] Text was empty after trim, not sending`);
        }
      } else {
        console.log(`[CocoAgent] No text blocks to send`);
      }

      // If no tool use, conversation turn is done but session stays active
      // Session remains active for follow-up questions (expires via 30-min TTL)
      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        await metrics.trackEvent("agent_turn_completed" as any, {
          userId: context.userId,
          sessionId: session.sessionId,
          turns: turnCount.toString(),
        });

        return {
          success: true,
          status: "complete",
          session: (await getSession(context.userId, context.threadId))!,
        };
      }

      // Handle tool use
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`[CocoAgent] Tool call: ${toolUse.name}`);

        const tool = getTool(toolUse.name);

        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: Unknown tool "${toolUse.name}"`,
            is_error: true,
          });
          continue;
        }

        // Execute the tool
        const result = await tool.execute(
          toolUse.input as Record<string, unknown>,
          context,
        );

        await metrics.trackEvent("agent_tool_used" as any, {
          userId: context.userId,
          tool: toolUse.name,
          success: result.success.toString(),
        });

        // Check if tool requires user action (pause agent)
        if (result.requiresUserAction) {
          console.log(`[CocoAgent] Tool requires user action, pausing...`);

          // Add the assistant message with tool use to history
          messages.push({
            role: "assistant",
            content: response.content,
          });

          return {
            success: true,
            status: "awaiting_action",
            message: result.displayMessage,
            session: (await getSession(context.userId, context.threadId))!,
          };
        }

        // Add tool result
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.success
            ? safeJsonStringify(result.data)
            : `Error: ${result.error}`,
          is_error: !result.success,
        });
      }

      // Add assistant message and tool results to conversation
      messages.push({
        role: "assistant",
        content: response.content,
      });

      messages.push({
        role: "user",
        content: toolResults,
      });
    }

    // Max turns reached
    console.log(`[CocoAgent] Max turns reached`);

    await updateSessionStatus(context.userId, context.threadId, "error");

    return {
      success: false,
      status: "max_turns",
      error: "Maximum conversation turns reached",
      session: (await getSession(context.userId, context.threadId))!,
    };
  }

  /**
   * Build messages array from session history
   */
  private buildMessages(
    session: AgentSession,
    newMessage?: string,
  ): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add session history (simplified)
    // Filter out empty messages
    for (const msg of session.messages.slice(-10)) {
      if (msg.role === "user" && msg.content && msg.content.trim()) {
        messages.push({ role: "user", content: msg.content });
      } else if (
        msg.role === "assistant" &&
        msg.content &&
        msg.content.trim()
      ) {
        messages.push({ role: "assistant", content: msg.content });
      }
    }

    // Add new user message if provided and not empty
    if (newMessage && newMessage.trim()) {
      messages.push({ role: "user", content: newMessage });
    }

    return messages;
  }
}

let agentInstance: CocoAgent | null = null;

export function getCocoAgent(config?: Partial<AgentConfig>): CocoAgent {
  if (!agentInstance) {
    agentInstance = new CocoAgent(config);
  }
  return agentInstance;
}

/**
 * Run the Coco agent for a user message
 */
export async function runCocoAgent(
  message: string,
  handler: BotHandler,
  userId: string,
  channelId: string,
  threadId: string,
): Promise<AgentRunResult> {
  const agent = getCocoAgent();
  return agent.run(message, handler, userId, channelId, threadId);
}

/**
 * Resume the Coco agent after user action
 */
export async function resumeCocoAgent(
  handler: BotHandler,
  userId: string,
  channelId: string,
  threadId: string,
  actionResult: {
    type: "transaction" | "confirmation";
    success: boolean;
    data?: Record<string, unknown>;
  },
): Promise<AgentRunResult> {
  const agent = getCocoAgent();
  return agent.resume(handler, userId, channelId, threadId, actionResult);
}

/**
 * Create agent context from event data
 */

export function createAgentContext(
  handler: BotHandler,
  userId: string,
  channelId: string,
  threadId: string,
  sessionId: string,
): AgentContext {
  return {
    userId,
    channelId,
    threadId,
    handler,
    sessionId,

    sendMessage: async (message: string) => {
      try {
        console.log(
          `[AgentContext] Sending message to channel ${channelId}, thread ${threadId}`,
        );
        console.log(
          `[AgentContext] Message preview: "${message.substring(0, 100)}..."`,
        );
        await handler.sendMessage(channelId, message, { threadId });
        console.log(`[AgentContext] Message sent successfully`);
      } catch (error) {
        console.error(`[AgentContext] Failed to send message:`, error);
        throw error;
      }
    },

    sendTransaction: async (tx: TransactionRequest) => {
      try {
        console.log(`[AgentContext] Sending transaction request: ${tx.id}`);
        await handler.sendInteractionRequest(
          channelId,
          {
            type: "transaction",
            id: tx.id,
            title: tx.title,
            tx: {
              chainId: tx.chainId,
              to: tx.to,
              value: tx.value,
              data: tx.data,
              signerWallet: tx.signerWallet,
            },
            recipient: userId as `0x${string}`,
          },
          { threadId },
        );
        console.log(`[AgentContext] Transaction request sent successfully`);
      } catch (error) {
        console.error(
          `[AgentContext] Failed to send transaction request:`,
          error,
        );
        throw error;
      }
    },
  };
}

function safeJsonStringify(data: unknown): string {
  return JSON.stringify(data, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}
