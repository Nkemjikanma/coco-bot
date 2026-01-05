import { BotHandler } from "@towns-protocol/bot";
import {
  getActiveFlow,
  isSubdomainFlow,
  clearUserPendingCommand,
  clearActiveFlow,
  updateFlowData,
  updateFlowStatus,
} from "../../../db";
import { formatAddress } from "../../../utils";

export async function subdomainTransaction(
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
): Promise<void> {
  const { userId, channelId, eventId } = event;

  // Extract threadId from requestId
  const threadId = event.threadId || eventId;

  // Get flow
  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success || !isSubdomainFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      `❌ Subdomain flow not found. Please start again.`,
      { threadId },
    );
    await clearUserPendingCommand(userId);
    return;
  }

  const flow = flowResult.data;
  const flowData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `The subdomain creation was cancelled.`,
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Update flow and mark complete
  await updateFlowData(userId, threadId, {
    txHash: tx.txHash as `0x${string}`,
  });
  await updateFlowStatus(userId, threadId, "complete");

  // Success!
  await handler.sendMessage(
    channelId,
    `🎉 **Subdomain Created & Assigned!**\n\n` +
      `**${flowData.fullName}** now:\n` +
      `• Points to: \`${flowData.recipient}\`\n` +
      `• Owned by: \`${formatAddress(flowData.recipient)}\`\n\n` +
      `**Transaction:** \`${tx.txHash}\`\n\n` +
      `The subdomain is now active and ready to use! 🚀`,
    { threadId: threadId },
  );

  // Clean up
  await clearActiveFlow(userId, threadId);
  await clearUserPendingCommand(userId);
}
