import type { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  updateFlowStatus,
} from "../../../db";
import { isTransferFlow } from "../../../db/flow";
import { getTransferService } from "../../../services/ens/transfer/transfer";
import { formatAddress } from "../../../utils";
import type { FormCase } from "../types";

export async function handleTransferConfirmation(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  form: FormCase,
) {
  const { userId, channelId, eventId } = event;
  const threadId = event.threadId || eventId;

  // Get transfer flow
  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success) {
    await handler.sendMessage(
      channelId,
      "❌ Transfer session expired. Please start again.",
      { threadId },
    );
    return;
  }

  if (!isTransferFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      "❌ Invalid session state. Please start again.",
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const transferData = flow.data;

  if (!form) {
    return;
  }

  // Check which button was clicked
  for (const component of form.components) {
    if (component.component?.case === "button") {
      if (component.id === "cancel") {
        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);
        await handler.sendMessage(channelId, "Transfer cancelled. 👋", {
          threadId,
        });
        return;
      }

      if (component.id === "confirm") {
        const service = getTransferService();

        // Build transaction
        const transferTx = service.buildTransferServiceTransaction({
          name: transferData.domain,
          owner: transferData.ownerWallet,
          isNameWrapped: transferData.isWrapped,
          recepientAddress: transferData.recipient,
        });

        console.log(`handleTransferConfirmation: Built transaction:`, {
          to: transferTx.to,
          data: transferTx.data.slice(0, 20) + "...",
          chainId: transferTx.chainId,
        });

        // Update flow status
        await updateFlowStatus(userId, threadId, "step1_pending");

        // Send transaction request
        await handler.sendInteractionRequest(
          channelId,
          {
            type: "transaction",
            id: `transfer:${userId}:${threadId}`,
            title: `Transfer ${transferData.domain} to ${formatAddress(transferData.recipient)}`,
            tx: {
              chainId: transferTx.chainId.toString(),
              to: transferTx.to,
              value: "0",
              data: transferTx.data,
              signerWallet: transferData.ownerWallet,
            },
            recipient: userId as `0x${string}`,
          },
          { threadId },
        );

        await handler.sendMessage(
          channelId,
          `📤 **Transfer Transaction**\n\n` +
            `` +
            `Please approve the transaction to transfer **${transferData.domain}** to \`${formatAddress(transferData.recipient)}\`.`,
          { threadId },
        );

        return;
      }
    }
  }
}
