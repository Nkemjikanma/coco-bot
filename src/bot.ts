import { makeTownsBot } from "@towns-protocol/bot";
import commands from "./commands";
import { getActiveFlow, getUserState } from "./db";
import { handleOnMessage, handleSlashCommand } from "./handlers";
import { handleSubdomainTransaction } from "./handlers/handleSubdomainCommand";
import {
  confirmCommit,
  confirmRegister,
  continueAfterBridge,
  durationForm,
  walletSelection,
} from "./handlers/interactionHandlers/form";
import { handleTransferConfirmation } from "./handlers/interactionHandlers/form/transferConfirmation";
import {
  bridgeTransaction,
  commitTransaction,
  registerTransaction,
} from "./handlers/interactionHandlers/transaction";
import { handleTransferTransaction } from "./handlers/interactionHandlers/transaction/transferTransaction";
import { shouldRespondToMessage } from "./handlers/interactionHandlers/utils";
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
  // "renew",
  "transfer",
  // "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  // "remind",
  // "watch",
] as const;

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    await handleSlashCommand(handler, event);
  });
}

bot.onMessage(async (handler, event) => {
  console.log("userId is mine", event.userId);
  if (event.userId === bot.botId) return;

  const shouldRespond = await shouldRespondToMessage(event);

  if (shouldRespond) {
    if (
      event.message
        .trim()
        .split(" ")
        .filter((m) => m.toLowerCase() !== "@coco").length === 0
    ) {
      await handler.sendMessage(
        event.channelId,
        "You sent an empty message ser",
        {
          threadId: event.threadId || event.eventId,
        },
      );
    }

    await handleOnMessage(handler, event);
  }
});

bot.onInteractionResponse(async (handler, event) => {
  const { userId, response, channelId, threadId, eventId } = event;
  const validThreadId = threadId || eventId;

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

      console.log("=== TRANSACTION RESPONSE IN BOT.TS ===");
      console.log("Request ID:", tx.requestId);
      console.log("TX Hash:", tx.txHash);
      console.log("======================================");

      if (
        tx.requestId.startsWith("subdomain_step1:") ||
        tx.requestId.startsWith("subdomain_step2:") ||
        tx.requestId.startsWith("subdomain_step3:")
      ) {
        console.log("🔀 Routing to subdomain transaction handler");
        await handleSubdomainTransaction(handler, event, tx);
        return;
      }

      //  check for state (either pendingCommand or activeFlow)
      const userState = await getUserState(userId);
      const flowResult = await getActiveFlow(userId, validThreadId);

      const hasState = userState?.pendingCommand || flowResult.success;

      if (!hasState) {
        console.log("❌ EARLY EXIT: No pending command or active flow!");
        await handler.sendMessage(
          channelId,
          "Sorry, I lost track of what we were doing. Please start again.",
          { threadId: validThreadId },
        );
        return;
      }

      // Handle commit transaction
      if (tx.requestId.startsWith("commit:")) {
        await commitTransaction(handler, event, tx);
        return;
      }

      // Handle bridge transaction
      if (tx.requestId.startsWith("bridge:")) {
        await bridgeTransaction(handler, event, tx);
        return;
      }

      // Handle register transaction
      if (tx.requestId.startsWith("register:")) {
        await registerTransaction(handler, event, tx);
        return;
      }

      if (tx.requestId.startsWith("transfer")) {
        await handleTransferTransaction(handler, event, tx);
      }

      console.log("⚠️ Unknown transaction type:", tx.requestId);
      break;
    }

    case "form": {
      const userState = await getUserState(userId);

      if (!userState?.pendingCommand) {
        console.log("❌ EARLY EXIT: No pending command for form response!");
        await handler.sendMessage(
          channelId,
          "Sorry, I lost track of what we were doing. Please start again.",
          { threadId: validThreadId },
        );
        return;
      }

      const form = response.payload.content.value;

      if (form.requestId.startsWith("confirm_commit")) {
        await confirmCommit(handler, event, form);
        return;
      }

      if (form.requestId.startsWith("duration_form")) {
        await durationForm(handler, event, form, userState);
        return;
      }

      if (form.requestId.startsWith("confirm_register")) {
        await confirmRegister(handler, event, form);
        return;
      }

      if (form.requestId.startsWith("continue_after_bridge")) {
        await continueAfterBridge(handler, event, form, userState);
        return;
      }

      if (form.requestId.startsWith("wallet_select:")) {
        await walletSelection(handler, event, form);
        console.log("Bot.ts: ‼️ We have passed to wallet select");
        return;
      }

      if (form.requestId.startsWith("bridge:")) {
        // Bridge confirmation form - route to wallet selection or bridge handler
        await walletSelection(handler, event, form);
        return;
      }

      if (form.requestId.startsWith("transfer_confirm:")) {
        console.log("here now");
        await handleTransferConfirmation(handler, event, form);
        return;
      }

      console.log("⚠️ Unknown form type:", form.requestId);
      break;
    }

    default: {
      console.log("‼️ Unknown response type:", response.payload.content.case);
    }
  }
});
