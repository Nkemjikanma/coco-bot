import { BotHandler } from "@towns-protocol/bot";
import {
  getActiveFlow,
  clearActiveFlow,
  updateFlowStatus,
  updateFlowData,
  clearUserPendingCommand,
} from "../../../db";
import { isTransferFlow } from "../../../db/flow";

export async function handleTransferTransaction(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  tx: {
    requestId: string;
    txHash: string;
  },
) {
  const { userId, channelId, eventId } = event;
  const threadId = event.threadId || eventId;

  // Get transfer flow
  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success) {
    await handler.sendMessage(channelId, "❌ Transfer session expired.", {
      threadId,
    });
    return;
  }

  if (!isTransferFlow(flowResult.data)) {
    await handler.sendMessage(channelId, "❌ Invalid session state.", {
      threadId,
    });
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const transferData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await updateFlowStatus(userId, threadId, "failed");
    await handler.sendMessage(
      channelId,
      `❌ **Transfer Rejected**\n\n` +
        `The transfer transaction was cancelled.`,
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Update flow with tx hash and mark complete
  await updateFlowData(userId, threadId, {
    ...transferData,
    txHash: tx.txHash as `0x${string}`,
  });
  await updateFlowStatus(userId, threadId, "complete");

  // Success message
  await handler.sendMessage(
    channelId,
    `🎉 **Transfer Complete!**\n\n` +
      `**${transferData.domain}** has been transferred to:\n` +
      `\`${transferData.recipient}\`\n\n` +
      `**Transaction:** \`${tx.txHash}\`\n\n` +
      `The new owner can now manage this name at [app.ens.domains](https://app.ens.domains).`,
    { threadId },
  );

  // Clean up
  await clearActiveFlow(userId, threadId);
  await clearUserPendingCommand(userId);
}
