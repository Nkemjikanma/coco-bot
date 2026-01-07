import type { BotHandler } from "@towns-protocol/bot";
import { clearUserPendingCommand } from "../../../db";
import {
  clearActiveFlow,
  getActiveFlow,
  isRenewFlow,
  updateFlowStatus,
} from "../../../db/flow";
import { getRenewService } from "../../../services/ens/renew/renew";
import type { FormCase } from "../types";

export async function handleRenewConfirmation(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  form: FormCase,
): Promise<void> {
  const { userId, channelId, eventId } = event;
  const threadId = event.threadId || eventId;

  // Get flow
  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success) {
    await handler.sendMessage(
      channelId,
      `❌ Renewal data not found. Please start again with \`/renew\`.`,
      { threadId },
    );
    return;
  }

  if (!isRenewFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      "❌ Invalid renew state. Please start again.",
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const renewData = flow.data;

  if (!form) {
    return;
  }

  for (const component of form.components) {
    if (component.id === "cancel") {
      await handler.sendMessage(channelId, `❌ Renewal cancelled.`, {
        threadId,
      });
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
      return;
    }

    if (component.id === "confirm") {
      // Build transaction
      const renewService = getRenewService();
      const tx = renewService.buildRenewalTransaction({
        labelName: renewData.labelName,
        durationSeconds: renewData.durationSeconds,
        valueWei: renewData.recommendedValueWei,
      });

      // Update flow status
      await updateFlowStatus(userId, threadId, "renew_pending");

      // Send transaction request
      await handler.sendInteractionRequest(
        channelId,
        {
          type: "transaction",
          id: `renew_tx:${userId}:${threadId}`,
          title: `Renew ${renewData.name}`,
          tx: {
            chainId: "1",
            to: tx.to,
            value: tx.valueHex,
            data: tx.data,
            signerWallet: renewData.ownerWallet,
          },
          recipient: userId as `0x${string}`,
        },
        { threadId },
      );

      await handler.sendMessage(
        channelId,
        `📤 **Renewal Transaction**\n\n` +
          `Please approve the transaction to renew **${renewData.name}** for ${renewData.durationYears} year${renewData.durationYears > 1 ? "s" : ""}.`,
        { threadId },
      );
    }
  }
}
