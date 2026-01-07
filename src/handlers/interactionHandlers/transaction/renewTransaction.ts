import type { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  updateFlowData,
  updateFlowStatus,
} from "../../../db";
import { isRenewFlow } from "../../../db/flow";
import { formatDate } from "../../../services/ens/renew/renew.utils";
import { metrics } from "../../../services/metrics/metrics";
import { handleCommandCompletion } from "../../commandCompletion";

export async function handleRenewTransaction(
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
  const parts = tx.requestId.split(":");
  const originalThreadId = parts[2];
  const threadId = event.threadId || originalThreadId || eventId;

  // Get flow
  const flowResult = await getActiveFlow(userId, originalThreadId);

  if (!flowResult.success) {
    await handler.sendMessage(
      channelId,
      `❌ Renewal flow not found. Please start again.`,
      { threadId },
    );
    return;
  }

  if (!isRenewFlow(flowResult.data)) {
    await handler.sendMessage(channelId, "❌ Invalid renew session state.", {
      threadId,
    });
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const renewData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await metrics.trackEvent("renew_failed", {
      userId,
      name: renewData.name,
      reason: "user_rejected",
    });
    await updateFlowStatus(userId, threadId, "failed");
    await handler.sendMessage(
      channelId,
      `❌ **Renewal Cancelled**\n\n` +
        `The transaction was rejected. ${renewData.name} was not renewed.`,
      { threadId },
    );

    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Success!
  // await metrics.trackEvent("renew_compoleted", {
  //   userId,
  //   name: renewData.name,
  //   txHash: tx.txHash,
  // });

  await updateFlowData(userId, originalThreadId, {
    ...renewData,
    txHash: tx.txHash as `0x${string}`,
  });
  await updateFlowStatus(userId, originalThreadId, "complete");

  // Track successful renewal
  await metrics.trackTransaction({
    type: "renew",
    name: renewData.name,
    costWei: renewData.totalCostWei.toString(),
    costEth: renewData.totalCostEth,
    txHash: tx.txHash,
    userId,
    timestamp: Date.now(),
  });

  await metrics.trackEvent("renew_compoleted", {
    userId,
    name: renewData.name,
    duration: renewData.durationYears.toString(),
    txHash: tx.txHash,
  });

  await handler.sendMessage(
    channelId,
    `🎉 **Renewal Successful!**\n\n` +
      `**${renewData.name}** has been renewed for ${renewData.durationYears} year${renewData.durationYears > 1 ? "s" : ""}!\n\n` +
      `📅 **New expiry:** ${formatDate(renewData.newExpiry)}\n\n` +
      `🔗 **Transaction:** [View on Etherscan](https://etherscan.io/tx/${tx.txHash})`,
    { threadId },
  );

  // Clean up

  await clearActiveFlow(userId, originalThreadId);
  await handleCommandCompletion(
    handler,
    channelId,
    threadId,
    userId,
    "renew",
    renewData.name,
  );
}
