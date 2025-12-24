import { makeTownsBot, type BotHandler } from "@towns-protocol/bot";
import commands from "./commands";
import {
  clearUserPendingCommand,
  getUserState,
  sessionExists,
  getPendingRegistration,
  clearPendingRegistration,
  updatePendingRegistration,
  getBridgeState,
  updateBridgeState,
} from "./db";
import {
  executeValidCommand,
  handleOnMessage,
  handlePendingCommandResponse,
  handleSlashCommand,
} from "./handlers";

import { hexToBytes, formatEther } from "viem";
import { ENS_CONTRACTS, REGISTRATION } from "./services/ens/constants";

import type { ParsedCommand, PendingCommand, RegisterCommand } from "./types";
import { encodeCommitData, encodeRegisterData } from "./services/ens";
import { estimateRegisterGas } from "./services/ens/ens";
import { threadId } from "worker_threads";
import { checkBalance } from "./utils";
import { CHAIN_IDS } from "./services/bridge";
import {
  confirmCommit,
  confirmRegister,
  durationForm,
} from "./handlers/interactionHandlers/form";
import {
  bridgeTransaction,
  commitTransaction,
  registerTransaction,
} from "./handlers/interactionHandlers/transaction";
import { shouldRespondToMessage } from "./handlers/interactionHandlers/utils";

// import { handleInteractionResponse } from "./handlers";

const APP_DATA = process.env.APP_PRIVATE_DATA;
const SECRET = process.env.JWT_SECRET;

if (!APP_DATA || !SECRET) {
  throw new Error("Missing APP_DATA or SECRET information. Fix env");
}
export const bot = await makeTownsBot(APP_DATA, SECRET, {
  commands,
});

const cocoCommands = [
  "help",
  "check",
  "register",
  "renew",
  "transfer",
  "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  "remind",
  "watch",
] as const;

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    await handleSlashCommand(handler, event);
  });
}

bot.onMessage(async (handler, event) => {
  // if message is from bot, ignore
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
        "You sent an empty messsage ser",
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

  const userState = await getUserState(userId);

  if (!userState?.pendingCommand) {
    await handler.sendMessage(
      channelId,
      "Sorry, I lost track of what we were doing. Please start again.",
    );
    return;
  }

  switch (response.payload.content.case) {
    case "form": {
      const form = response.payload.content.value;

      if (form.requestId.startsWith("confirm_commit")) {
        const confirmForm = form.requestId.startsWith("confirm_commit") && form;
        await confirmCommit(handler, event, confirmForm, userState);

        return;
      }

      if (form.requestId.startsWith("duration_form")) {
        const durationForForm =
          form.requestId.startsWith("duration_form") && form;
        await durationForm(handler, event, durationForForm, userState);
        return;
      }

      if (form.requestId.startsWith("confirm_register")) {
        const confirmForRegister =
          form.requestId.startsWith("confirm_register") && form;

        await confirmRegister(handler, event, confirmForRegister, userState);
        return;
      }

      if (form.requestId.startsWith("continue_after_bridge")) {
        const bridgeForm =
          form.requestId.startsWith("continue_after_bridge") && form;

        await durationForm(handler, event, bridgeForm, userState);
        return;
      }
      break;
    }

    case "transaction": {
      const tx = response.payload.content.value;

      // Check if this is a commit transaction
      if (tx.requestId.startsWith("commit:")) {
        await commitTransaction(handler, event, tx, userState);
      }

      if (tx.requestId.startsWith("bridge:")) {
        await bridgeTransaction(handler, event, tx, userState);
      }

      // Handle register transaction
      if (tx.requestId.startsWith("register:")) {
        await registerTransaction(handler, event, tx, userState);
      }
      break;
    }
  }
});
