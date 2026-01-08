import Anthropic from "@anthropic-ai/sdk";
import type { BotHandler } from "@towns-protocol/bot";
import { metrics } from "../services/metrics/metrics";
import { COCO_SYSTEM_PROMPT, COCO_TOOL_GUIDELINES } from "./prompts";
import {
  addSessionMessage,
  completeSession,
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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

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

  async run(
    message: string,
    handler: BotHandler,
    userId: string,
    channelId: string,
    threadId: string,
  ): Promise<AgentRunResult> {
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

    // Add action result to session messages
    const resultMessage = actionResult.success
      ? `User completed the action. ${actionResult.type === "transaction" ? `Transaction hash: ${actionResult.data?.txHash}` : "Confirmed."}`
      : `User rejected/cancelled the action.`;

    await addSessionMessage(userId, threadId, {
      role: "tool_result",
      content: resultMessage,
      toolName: session.pendingToolCall?.toolName,
      toolId: session.pendingToolCall?.toolId,
    });

    // Update session status
    await updateSessionStatus(userId, threadId, "active");

    // Build messages including the tool result
    const messages = this.buildMessages(session, undefined, {
      toolId: session.pendingToolCall?.toolId || "",
      result: resultMessage,
    });

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

      // Process response
      const textBlocks: string[] = [];
      const toolUseBlocks: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textBlocks.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseBlocks.push(block);
        }
      }

      // Send any text responses to user
      if (textBlocks.length > 0) {
        const text = textBlocks.join("\n");
        if (text.trim()) {
          await context.sendMessage(text);
          await addSessionMessage(context.userId, context.threadId, {
            role: "assistant",
            content: text,
          });
        }
      }

      // If no tool use, we're done
      if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
        await completeSession(context.userId, context.threadId);

        await metrics.trackEvent("agent_session_completed" as any, {
          userId: context.userId,
          sessionId: session.sessionId,
          turns: turnCount.toString(),
          outcome: "success",
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
            ? JSON.stringify(result.data)
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
    toolResult?: { toolId: string; result: string },
  ): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = [];

    // Add session history (simplified)
    for (const msg of session.messages.slice(-10)) {
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content });
      }
      // tool_result messages are handled separately
    }

    // Add new user message if provided
    if (newMessage) {
      messages.push({ role: "user", content: newMessage });
    }

    // Add tool result if resuming
    if (toolResult) {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolResult.toolId,
            content: toolResult.result,
          },
        ],
      });
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
      await handler.sendMessage(channelId, message, { threadId });
    },

    sendTransaction: async (tx: TransactionRequest) => {
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
    },
  };
}
