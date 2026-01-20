import { makeTownsBot } from "@towns-protocol/bot";
import {
  clearSessionPendingAction,
  getSession,
  isAwaitingUserAction,
  resumeCocoAgent,
  runCocoAgent,
} from "./ai";
import commands from "./commands";
import { metrics } from "./services/metrics/metrics";
import type { CocoBotType } from "./types";

const APP_DATA = process.env.APP_PRIVATE_DATA;
const SECRET = process.env.JWT_SECRET;

if (!APP_DATA || !SECRET) {
  throw new Error("Missing APP_DATA or SECRET information. Fix env");
}

export const bot: CocoBotType = await makeTownsBot(APP_DATA, SECRET, {
  commands,
});

const cocoCommands = [
  "help",
  "check",
  "register",
  "renew",
  "transfer",
  // "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  "setprimary",
  // "remind",
  // "watch",
  "stats",
] as const;

const writeCommands = [
  "register",
  "renew",
  "transfer",
  "subdomain",
  "setprimary",
];

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    if (command === "stats" && event.userId === process.env.DEV_ID!) {
      const overview = await metrics.getOverview();
      const commandStats = await metrics.getCommandStats();

      const message =
        `📊 **Coco Bot Statistics**\n\n` +
        `**Usage:**\n` +
        `• Total Commands: ${overview.totalCommands}\n` +
        `• Daily Active Users: ${overview.dailyActiveUsers}\n\n` +
        `**Transactions:**\n` +
        `• Registrations: ${overview.totalRegistrations}\n` +
        `• Transfers: ${overview.totalTransfers}\n` +
        `• Subdomains: ${overview.totalSubdomains}\n` +
        `• Bridges: ${overview.totalBridges}\n\n` +
        `**Total Gas Spent:** ${overview.totalCostEth} ETH\n\n` +
        `**Command Breakdown:**\n` +
        Object.entries(commandStats)
          .sort(([, a], [, b]) => b - a)
          .map(([cmd, count]) => `• ${cmd}: ${count}`)
          .join("\n");

      const validThreadId = event.threadId || event.eventId;
      const mention = event.mentions.find((m) => m.userId === event.userId);
      await handler.sendMessage(event.channelId, message, {
        threadId: validThreadId,
        mentions: [
          { userId: event.userId, displayName: mention?.displayName || "" },
        ],
      });
      return;
    }

    const threadId = event.threadId || event.eventId;

    try {
      // Check if we're awaiting user action (shouldn't process new messages)
      const isAwaiting = await isAwaitingUserAction(event.userId, threadId);

      // check if is write command because use should be able to query info freely
      const isWriteCommand = writeCommands.some(
        (writeCommand) => writeCommand === command,
      );
      if (isAwaiting && isWriteCommand) {
        console.log(`[Bot] User has pending action, ignoring message`);
        // Optionally remind them
        await handler.sendMessage(
          event.channelId,
          "⏳ Please complete the pending transaction or cancel it first.",
          { threadId: threadId },
        );
        return;
      }

      // Run the agent
      const result = await runCocoAgent(
        `${command} ${event.args.join(" ")}`,
        handler,
        event.userId,
        event.channelId,
        threadId,
      );

      console.log(`[Bot] Agent result: ${result.status}`);

      // Agent handles all messaging, we just log the result
      if (!result.success && result.error) {
        console.error(`[Bot] Agent error: ${result.error}`);
      }
    } catch (error) {
      console.error("[Bot] Unexpected error:", error);

      await handler.sendMessage(
        event.channelId,
        "❌ Something went wrong. Please try again.",
        { threadId: threadId },
      );
    }
  });
}

bot.onMessage(async (handler, event) => {
  if (!event.message?.trim()) return; // empty message
  if (event.userId === bot.botId) return; //bot address

  const threadId = event.threadId || event.eventId;
  const message = event.message.trim().toLowerCase();

  try {
    // Check if we're awaiting user action (shouldn't process new messages)
    const isAwaiting = await isAwaitingUserAction(event.userId, threadId);
    const userSession = await getSession(event.userId, threadId);

    // Allow "cancel" messages even when awaiting action
    const isCancelRequest =
      message.includes("cancel") ||
      message.includes("stop") ||
      message.includes("nevermind");

    if (isAwaiting && !isCancelRequest) {
      console.log(`[Bot] User has pending action, ignoring message`);
      // Optionally remind them
      await handler.sendMessage(
        event.channelId,
        "⏳ Please complete the pending transaction or cancel it first. Say 'cancel' to cancel the current action.",
        { threadId: threadId },
      );
      return;
    }

    // If cancelling, clear the pending action first
    if (isAwaiting && isCancelRequest && userSession?.userId === event.userId) {
      console.log(`[Bot] User requested cancel, clearing pending action`);
      await clearSessionPendingAction(event.userId, threadId);
    }

    // Run the agent
    const result = await runCocoAgent(
      event.message,
      handler,
      event.userId,
      event.channelId,
      threadId,
    );

    console.log(`[Bot] Agent result: ${result.status}`);

    // Agent handles all messaging, we just log the result
    if (!result.success && result.error) {
      console.error(`[Bot] Agent error: ${result.error}`);
    }
  } catch (error) {
    console.error("[Bot] Unexpected error:", error);

    await handler.sendMessage(
      event.channelId,
      "❌ Something went wrong. Please try again.",
      { threadId: threadId },
    );
  }
});

bot.onInteractionResponse(async (handler, event) => {
  const { response, eventId } = event;
  const userId = event.userId;
  const channelId = event.channelId;
  const threadId = event.threadId || eventId;

  console.log("========================================");
  console.log("🔔 INTERACTION RESPONSE RECEIVED");
  console.log("========================================");
  console.log("Response type:", response.payload.content.case);
  console.log("User ID:", userId);
  console.log("Channel ID:", channelId);
  console.log("Thread ID:", threadId);
  console.log("Event ID:", eventId);

  if (response.payload.content.case === "transaction") {
    const tx = response.payload.content.value;
    console.log("📝 TRANSACTION RESPONSE:");
    console.log("  Request ID:", tx.requestId);
    console.log("  TX Hash:", tx.txHash);
  }
  console.log("========================================\n");

  switch (response.payload.content.case) {
    case "transaction": {
      const tx = response.payload.content.value;
      const success = !!tx.txHash && tx.txHash !== "" && tx.txHash !== "0x";

      console.log("=== TRANSACTION RESPONSE IN BOT.TS ===");
      console.log("Request ID:", tx.requestId);
      console.log("TX Hash:", tx.txHash);
      console.log("======================================");

      console.log(
        `[Bot] Transaction ${success ? "success" : "rejected"}: ${tx.txHash}`,
      );

      // Resume the agent with the transaction result
      const result = await resumeCocoAgent(
        handler,
        userId,
        channelId,
        threadId,
        {
          type: "transaction",
          success,
          data: {
            txHash: tx.txHash,
            requestId: tx.requestId,
          },
        },
      );

      console.log(`[Bot] Agent resumed: ${result.status}`);

      // Track transaction if successful
      if (success) {
        const actionType = tx.requestId.split(":")[0];
        await metrics.trackEvent("transaction_signed" as any, {
          userId,
          actionType,
          txHash: tx.txHash || "",
        });
      }

      break;
    }

    case "form": {
      const form = response.payload.content.value;

      const buttonClicked = form.components.find(
        (c) => c.id === "confirm" || c.id === "cancel",
      );
      const confirmed = buttonClicked?.id === "confirm";

      console.log(`[Bot] Confirmation ${confirmed ? "accepted" : "rejected"}`);

      // Resume the agent with confirmation result
      const result = await resumeCocoAgent(
        handler,
        userId,
        channelId,
        threadId,
        {
          type: "confirmation",
          success: confirmed,
          data: {
            requestId: form.requestId,
            formData: form,
          },
        },
      );

      console.log(`[Bot] Agent resumed: ${result.status}`);
      break;
    }

    default: {
      console.log("‼️ Unknown response type:", response.payload.content.case);
    }
  }
});
