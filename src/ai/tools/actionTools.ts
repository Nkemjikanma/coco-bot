// src/agent/tools/actionTools.ts

import { setSessionPendingAction, updateSessionStatus } from "../sessions";
import type { AgentContext, ToolDefinition, ToolResult } from "../types";

/**
 * Format tool result
 */
function formatResult(data: unknown, displayMessage?: string): ToolResult {
  return {
    success: true,
    data,
    displayMessage,
  };
}

function formatError(error: string): ToolResult {
  return {
    success: false,
    error,
  };
}

// ============================================================
// SEND TRANSACTION
// ============================================================

export const sendTransactionTool: ToolDefinition = {
  name: "send_transaction",
  description: `Send a prepared transaction to the user for signing. Use this after preparing a transaction with prepare_* tools.
The agent will pause and wait for the user to sign or reject the transaction.`,
  parameters: {
    type: "object",
    properties: {
      actionType: {
        type: "string",
        description: "Type of action",
        enum: [
          "registration_commit",
          "registration_register",
          "renewal",
          "transfer",
          "subdomain_step1",
          "subdomain_step2",
          "subdomain_step3",
          "bridge",
        ],
      },
      title: {
        type: "string",
        description: "Title to display for the transaction",
      },
      to: {
        type: "string",
        description: "Contract address to call",
      },
      data: {
        type: "string",
        description: "Encoded transaction data",
      },
      value: {
        type: "string",
        description: "ETH value in hex (e.g., '0x0' or '0x...')",
      },
      signerWallet: {
        type: "string",
        description: "Wallet that should sign the transaction",
      },
      chainId: {
        type: "string",
        description: "Chain ID ('1' for mainnet, '8453' for Base)",
      },
      // Metadata for resuming
      metadata: {
        type: "object",
        description: "Additional data needed when transaction completes",
      },
    },
    required: ["actionType", "title", "to", "data", "value", "signerWallet"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const actionType = params.actionType as string;
    const title = params.title as string;
    const to = params.to as `0x${string}`;
    const data = params.data as `0x${string}`;
    const value = params.value as string;
    const signerWallet = params.signerWallet as `0x${string}`;
    const chainId = (params.chainId as string) || "1";
    const metadata = params.metadata as Record<string, unknown> | undefined;

    try {
      const requestId = `${actionType}:${context.userId}:${context.threadId}`;

      // Store pending action for resuming later
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "send_transaction",
          toolId: requestId,
          expectedAction: actionType,
        },
        {
          type: getActionTypeCategory(actionType),
          step: getStepNumber(actionType),
          totalSteps: getTotalSteps(actionType, metadata),
          data: metadata || {},
        },
      );

      // Send transaction request to user
      await context.sendTransaction({
        id: requestId,
        title,
        chainId,
        to,
        data,
        value,
        signerWallet,
      });

      return formatResult(
        {
          requestId,
          status: "awaiting_signature",
          actionType,
        },
        `📤 Transaction sent for signing. Waiting for user to approve...`,
      );
    } catch (error) {
      return formatError(
        `Failed to send transaction: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// SEND MESSAGE
// ============================================================

export const sendMessageTool: ToolDefinition = {
  name: "send_message",
  description:
    "Send a message to the user. Use for status updates, confirmations, or any communication that doesn't require a transaction.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description:
          "Message to send to the user. Supports markdown formatting.",
      },
    },
    required: ["message"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const message = params.message as string;

    try {
      await context.sendMessage(message);

      return formatResult({ sent: true }, "Message sent successfully.");
    } catch (error) {
      return formatError(
        `Failed to send message: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// WAIT (for registration 60s wait)
// ============================================================

export const waitTool: ToolDefinition = {
  name: "wait",
  description:
    "Wait for a specified duration. Use during registration flow to wait the required 60 seconds between commit and register.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "Number of seconds to wait",
      },
      reason: {
        type: "string",
        description: "Reason for waiting (displayed to user)",
      },
    },
    required: ["seconds"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const seconds = params.seconds as number;
    const reason = (params.reason as string) || "Processing...";

    // Cap at 120 seconds for safety
    const waitTime = Math.min(seconds, 120);

    try {
      // Send status message
      await context.sendMessage(`⏳ ${reason} (${waitTime} seconds)...`);

      // Update session status
      await updateSessionStatus(
        context.userId,
        context.threadId,
        "waiting_period",
      );

      // Wait
      await new Promise((resolve) => setTimeout(resolve, waitTime * 1000));

      // Update session back to active
      await updateSessionStatus(context.userId, context.threadId, "active");

      return formatResult(
        { waited: waitTime },
        `✅ Wait complete. Continuing...`,
      );
    } catch (error) {
      return formatError(
        `Wait interrupted: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// REQUEST CONFIRMATION
// ============================================================

export const requestConfirmationTool: ToolDefinition = {
  name: "request_confirmation",
  description:
    "Ask the user to confirm an action before proceeding. Use for important or irreversible actions.",
  parameters: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Confirmation message to show the user",
      },
      confirmLabel: {
        type: "string",
        description: "Label for confirm button (default: 'Confirm')",
      },
      cancelLabel: {
        type: "string",
        description: "Label for cancel button (default: 'Cancel')",
      },
    },
    required: ["message"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const message = params.message as string;
    const confirmLabel = (params.confirmLabel as string) || "✅ Confirm";
    const cancelLabel = (params.cancelLabel as string) || "❌ Cancel";

    try {
      const requestId = `confirm:${context.userId}:${context.threadId}:${Date.now()}`;

      // Store pending confirmation
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "request_confirmation",
          toolId: requestId,
          expectedAction: "confirmation",
        },
        undefined,
      );

      // Update status
      await updateSessionStatus(
        context.userId,
        context.threadId,
        "awaiting_confirmation",
      );

      // Send confirmation request
      await context.handler.sendInteractionRequest(
        context.channelId,
        {
          type: "form",
          id: requestId,
          title: "Confirmation Required",
          components: [
            {
              id: "confirm",
              type: "button",
              label: confirmLabel,
            },
            {
              id: "cancel",
              type: "button",
              label: cancelLabel,
            },
          ],
          recipient: context.userId as `0x${string}`,
        },
        { threadId: context.threadId },
      );

      // Send the message
      await context.sendMessage(message);

      return formatResult(
        {
          requestId,
          status: "awaiting_confirmation",
        },
        "Waiting for user confirmation...",
      );
    } catch (error) {
      return formatError(
        `Failed to request confirmation: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getActionTypeCategory(
  actionType: string,
): "registration" | "renewal" | "transfer" | "subdomain" | "bridge" {
  if (actionType.startsWith("registration")) return "registration";
  if (actionType.startsWith("subdomain")) return "subdomain";
  if (actionType === "renewal") return "renewal";
  if (actionType === "transfer") return "transfer";
  if (actionType === "bridge") return "bridge";
  return "registration";
}

function getStepNumber(actionType: string): number {
  if (actionType === "registration_commit") return 1;
  if (actionType === "registration_register") return 2;
  if (actionType === "subdomain_step1") return 1;
  if (actionType === "subdomain_step2") return 2;
  if (actionType === "subdomain_step3") return 3;
  return 1;
}

function getTotalSteps(
  actionType: string,
  metadata?: Record<string, unknown>,
): number {
  if (actionType.startsWith("registration")) return 2;
  if (actionType.startsWith("subdomain")) {
    return (metadata?.totalSteps as number) || 3;
  }
  return 1;
}

// ============================================================
// EXPORT ALL ACTION TOOLS
// ============================================================

export const actionTools: ToolDefinition[] = [
  sendTransactionTool,
  sendMessageTool,
  waitTool,
  requestConfirmationTool,
];
