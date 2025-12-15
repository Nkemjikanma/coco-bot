import { BotHandler } from "@towns-protocol/bot";
import {
  getPendingInteraction,
  deletePendingInteraction,
  validateInteraction,
  PendingInteraction,
  TransactionResponse,
  FormResponse,
} from "../db";
import { appendMessageToSession } from "../db";
import { clearUserPendingCommand } from "../db";

import {
  InteractionResponse,
  InteractionResponsePayload,
  InteractionResponsePayload_Form,
  InteractionResponsePayloadSchema,
} from "@towns-protocol/proto";

export interface InteractionResponseEvent {
  // Common fields
  userId: string;
  channelId: string;
  threadId?: string;

  // Response content - one of these based on interaction type
  transactionResponse?: TransactionResponse;
  formResponse?: FormResponse;
  signatureResponse?: {
    requestId: string;
    signature: string;
  };
}
//
// // called when bot.onInteractionResponse
// export async function handleInteractionResponse(
//   handler: BotHandler,
//   event: InteractionResponse,
//   event_payload: InteractionResponsePayload,
//   event_form: InteractionResponsePayload_Form,
// ): Promise<void> {
//   const { recipient, threadId, encryptedData } = event;
//   // const threadId = event.threadId || channelId;
//
//   // Handle Transaction response (user signed and submitted TX)
//   if (event.transactionResponse) {
//     await handleTransactionResponse(
//       handler,
//       event.transactionResponse,
//       userId,
//       channelId,
//       threadId,
//     );
//     return;
//   }
//
//   // Handle Form response (user clicked a button)
//   if (event.formResponse) {
//     await handleFormResponse(
//       handler,
//       event.formResponse,
//       userId,
//       channelId,
//       threadId,
//     );
//     return;
//   }
//
//   // Handle Signature response (user signed data)
//   if (event.signatureResponse) {
//     await handleSignatureResponse(
//       handler,
//       event.signatureResponse,
//       userId,
//       channelId,
//       threadId,
//     );
//     return;
//   }
//
//   console.warn("Unknown interaction response type:", event);
// }
//
// Handle Transaction response - user confirmed and signed the transaction
async function handleTransactionResponse(
  handler: BotHandler,
  response: TransactionResponse,
  userId: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  const { requestId, txHash } = response;

  // Validate the interaction
  const validation = await validateInteraction(requestId, userId);

  if (!validation.valid || !validation.interaction) {
    // Interaction expired or doesn't belong to user
    // But we still got a txHash, so just acknowledge it
    await handler.sendMessage(
      channelId,
      `✅ Transaction submitted!\n\n` +
        `[View on BaseScan](https://basescan.org/tx/${txHash})`,
      { threadId },
    );
    return;
  }

  const interaction = validation.interaction;
  const { command, title } = interaction;

  // Send success message
  await handler.sendMessage(
    channelId,
    `🎉 **${title}** - Success!\n\n` +
      `Transaction submitted and pending confirmation.\n\n` +
      `[View on BaseScan](https://basescan.org/tx/${txHash})`,
    { threadId },
  );

  // Clean up
  await deletePendingInteraction(requestId);
  await clearUserPendingCommand(userId);

  // Store in session
  await appendMessageToSession(threadId, userId, {
    eventId: `bot-${Date.now()}`,
    content: `Transaction submitted: ${txHash}`,
    timestamp: Date.now(),
    role: "assistant",
  });
}

// Handle Form response - user clicked confirm button or cancel button
async function handleFormResponse(
  handler: BotHandler,
  response: FormResponse,
  userId: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  const { requestId, components } = response;

  // Validate the interaction
  const validation = await validateInteraction(requestId, userId);

  if (!validation.valid || !validation.interaction) {
    await handler.sendMessage(
      channelId,
      "This request has expired. Please start over.",
      { threadId },
    );
    return;
  }

  const interaction = validation.interaction;

  // Find which button was clicked
  const clickedButton = components.find((c) => c.button !== undefined);

  if (clickedButton) {
    const buttonId = clickedButton.id;

    if (buttonId === "cancel") {
      // User cancelled
      await handler.sendMessage(
        channelId,
        `❌ Cancelled: ${interaction.title}\n\nNo worries! Let me know if you want to do something else. 👋`,
        { threadId },
      );

      await deletePendingInteraction(requestId);
      await clearUserPendingCommand(userId);
      return;
    }

    // Handle other buttons if needed
    console.log(`Button clicked: ${buttonId}`);
  }
}

// when user approves transaction by clicking confirm
async function handleSignatureResponse(
  handler: BotHandler,
  response: { requestId: string; signature: string },
  userId: string,
  channelId: string,
  threadId: string,
): Promise<void> {
  const { requestId, signature } = response;

  // Validate the interaction
  const validation = await validateInteraction(requestId, userId);

  if (!validation.valid) {
    await handler.sendMessage(
      channelId,
      "This request has expired. Please start over.",
      { threadId },
    );
    return;
  }

  // Handle the signature - this could be used for various purposes
  // For now, just acknowledge
  await handler.sendMessage(
    channelId,
    `✅ Signature received!\n\nProcessing your request...`,
    { threadId },
  );

  await deletePendingInteraction(requestId);
}

/**
 * Check if a command requires a transaction interaction
 */
export function requiresTransaction(action: string): boolean {
  return ["register", "renew", "transfer", "set"].includes(action);
}

/**
 * TODO: Get the appropriate chain ID for ENS operations
 */
export function getChainId(): string {
  // Base mainnet
  return "8453";
  // For testnet: return "84532" (Base Sepolia)
}
