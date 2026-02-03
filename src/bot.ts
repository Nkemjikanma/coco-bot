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

// Log bot identity info on startup
console.log("========================================");
console.log("🤖 BOT IDENTITY INFO");
console.log("  Bot ID (EOA):", bot.botId);
console.log("  App Address (Smart Account):", bot.appAddress);
console.log("========================================");

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
    console.log("========================================");
    console.log("🎯 SLASH COMMAND RECEIVED");
    console.log("  Command:", command);
    console.log("  User ID:", event.userId);
    console.log("  Channel ID:", event.channelId);
    console.log("  Space ID:", event.spaceId);
    console.log("  Event ID:", event.eventId);
    console.log("  Args:", event.args);
    console.log("========================================");

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
  console.log("========================================");
  console.log("💬 MESSAGE RECEIVED");
  console.log("  User ID:", event.userId);
  console.log("  Channel ID:", event.channelId);
  console.log("  Space ID:", event.spaceId);
  console.log("  Message:", event.message?.substring(0, 100));
  console.log("  Is Mentioned:", event.isMentioned);
  console.log("  Bot ID:", bot.botId);
  console.log("========================================");

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

    // Allow "done" / "signed" messages for bridge transactions that don't trigger onInteractionResponse
    const isBridgeConfirmation =
      message.includes("done") ||
      message.includes("signed") ||
      message.includes("i signed") ||
      message.includes("confirmed") ||
      message.includes("check") ||
      message.includes("continue");

    if (isAwaiting && !isCancelRequest && !isBridgeConfirmation) {
      console.log(`[Bot] User has pending action, ignoring message`);
      // Optionally remind them
      await handler.sendMessage(
        event.channelId,
        "⏳ Please complete the pending transaction or cancel it first. Say 'cancel' to cancel the current action, or 'done' if you've already signed.",
        { threadId: threadId },
      );
      return;
    }

    // If cancelling, clear the pending action first
    if (isAwaiting && isCancelRequest && userSession?.userId === event.userId) {
      console.log(`[Bot] User requested cancel, clearing pending action`);
      await clearSessionPendingAction(event.userId, threadId);
    }

    // If user says "done"/"signed" and there's a pending transaction, let them through
    let messageToProcess = event.message;
    if (isAwaiting && isBridgeConfirmation && userSession?.currentAction) {
      const actionType = userSession.currentAction.type;
      const actionData = userSession.currentAction.data || {};

      console.log(
        `[Bot] User confirmed ${actionType} transaction, clearing pending action`,
      );

      if (actionType === "bridge") {
        // For bridge, add context about not sending another bridge
        messageToProcess =
          `${event.message}\n\n` +
          `[SYSTEM: User is confirming a BRIDGE transaction that was ALREADY SENT. ` +
          `Wallet: ${actionData.walletAddress}. ` +
          `Do NOT call prepare_bridge again. ` +
          `Only call check_balance to verify Mainnet balance, then proceed with prepare_registration if sufficient.]`;
      } else if (actionType === "transfer") {
        // For transfer, add context about verifying the transfer
        const recipientAddress = actionData.toAddress || "the recipient";
        messageToProcess =
          `${event.message}\n\n` +
          `[SYSTEM: User is confirming a TRANSFER transaction that was ALREADY SENT. ` +
          `Name: ${actionData.name || "unknown"}. Recipient: ${recipientAddress}. ` +
          `Do NOT call prepare_transfer again. ` +
          `Call check_availability for the name to verify the new owner is ${recipientAddress}. ` +
          `If ownership transferred successfully, confirm and ask if they need anything else. ` +
          `If still showing old owner, the transaction may still be processing - tell user to wait.]`;
      } else if (actionType === "registration") {
        // For registration, check which step
        const step = userSession.currentAction.step || 1;
        if (step === 1) {
          messageToProcess =
            `${event.message}\n\n` +
            `[SYSTEM: User is confirming the COMMIT transaction (step 1) was signed. ` +
            `Name: ${actionData.name}. Wallet: ${actionData.walletAddress}. ` +
            `Do NOT call prepare_registration again. ` +
            `Proceed with the 60-second wait, then call complete_registration.]`;
        } else {
          messageToProcess =
            `${event.message}\n\n` +
            `[SYSTEM: User is confirming the REGISTER transaction (step 2) was signed. ` +
            `Name: ${actionData.name}. Wallet: ${actionData.walletAddress}. ` +
            `Do NOT call prepare_registration or complete_registration again. ` +
            `Call check_availability to verify the name is now owned by ${actionData.walletAddress}. ` +
            `If registered successfully, confirm and ask if they need anything else.]`;
        }
      } else if (actionType === "subdomain") {
        // For subdomain, check which step (1, 2, or 3)
        const step = userSession.currentAction.step || 1;
        const totalSteps = userSession.currentAction.totalSteps || 3;
        const fullName = actionData.fullName || actionData.name || "the subdomain";

        if (step < totalSteps) {
          // More steps to go
          const nextStep = step + 1;
          const nextTool = nextStep === 2 ? "complete_subdomain_step2" : "complete_subdomain_step3";
          messageToProcess =
            `${event.message}\n\n` +
            `[SYSTEM: User is confirming SUBDOMAIN step ${step} of ${totalSteps} was signed. ` +
            `Subdomain: ${fullName}. ` +
            `Do NOT call prepare_subdomain or the previous step again. ` +
            `Proceed to call ${nextTool} to continue with step ${nextStep}.]`;
        } else {
          // Final step completed
          messageToProcess =
            `${event.message}\n\n` +
            `[SYSTEM: User is confirming the FINAL subdomain step (${step} of ${totalSteps}) was signed. ` +
            `Subdomain: ${fullName}. ` +
            `Do NOT call any subdomain tools again. ` +
            `The subdomain should now be created. Confirm success and ask if they need anything else.]`;
        }
      } else if (actionType === "renewal") {
        // For renewal
        messageToProcess =
          `${event.message}\n\n` +
          `[SYSTEM: User is confirming a RENEWAL transaction that was ALREADY SENT. ` +
          `Name: ${actionData.name}. ` +
          `Do NOT call prepare_renewal again. ` +
          `Call get_expiry to verify the name's expiry date was extended. ` +
          `If renewed successfully, confirm and ask if they need anything else.]`;
      } else if (actionType === "set_primary") {
        // For set primary name
        messageToProcess =
          `${event.message}\n\n` +
          `[SYSTEM: User is confirming a SET PRIMARY NAME transaction that was ALREADY SENT. ` +
          `Name: ${actionData.name}. ` +
          `Do NOT call prepare_set_primary again. ` +
          `The primary name should now be set. Confirm success and ask if they need anything else.]`;
      } else {
        // Generic handling for other transaction types
        messageToProcess =
          `${event.message}\n\n` +
          `[SYSTEM: User is confirming a ${actionType} transaction that was ALREADY SENT. ` +
          `Do NOT send the same transaction again. ` +
          `Verify the action completed and proceed accordingly.]`;
      }

      // Clear pending action so agent can proceed
      await clearSessionPendingAction(event.userId, threadId);
    }

    // Run the agent
    const result = await runCocoAgent(
      messageToProcess,
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

// Catch-all event handler to debug what events are being received
bot.onStreamEvent(async (handler, event) => {
  console.log("========================================");
  console.log("📡 RAW STREAM EVENT RECEIVED");
  console.log("  Event ID:", event.eventId);
  console.log("  Channel ID:", event.channelId);
  console.log("  Space ID:", event.spaceId);
  console.log("  User ID:", event.userId);
  console.log("  Parsed event type:", event.parsed?.event?.case);
  console.log(
    "  Full parsed event:",
    JSON.stringify(
      event.parsed?.event,
      (_, v) =>
        typeof v === "bigint"
          ? v.toString()
          : v instanceof Uint8Array
            ? `[Uint8Array ${v.length}]`
            : v,
      2,
    )?.substring(0, 500),
  );
  console.log("========================================");
});

// Log channel joins to see if bot sees itself joining
bot.onChannelJoin(async (handler, event) => {
  console.log("========================================");
  console.log("👋 CHANNEL JOIN EVENT");
  console.log("  User ID:", event.userId);
  console.log("  Channel ID:", event.channelId);
  console.log("  Space ID:", event.spaceId);
  console.log("========================================");
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
