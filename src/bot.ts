import {
  getSmartAccountFromUserId,
  makeTownsBot,
  type BotHandler,
  Bot,
  BotCommand,
} from "@towns-protocol/bot";
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
import { handleOnMessage, handleSlashCommand } from "./handlers";

import {
  confirmCommit,
  confirmRegister,
  continueAfterBridge,
  durationForm,
  walletSelection,
} from "./handlers/interactionHandlers/form";
import {
  bridgeTransaction,
  commitTransaction,
  registerTransaction,
  testBridgeTransaction,
} from "./handlers/interactionHandlers/transaction";
import { shouldRespondToMessage } from "./handlers/interactionHandlers/utils";
import { testBridge } from "./services/bridge/testBridge";
import { SpaceAddressFromSpaceId } from "@towns-protocol/web3";
import { CocoBotType } from "./types";

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
  "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  "remind",
  "watch",
  "test_bridge",
] as const;

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    if (command === "test_bridge") {
      return;
      // const { channelId, userId, args } = event;
      // const threadId = event.threadId ?? event.eventId;
      // // Get amount from args, default to 0.001 ETH
      // const amountEth = args[0] || "0.001";
      // // Validate amount
      // const amount = parseFloat(amountEth);
      // if (isNaN(amount) || amount <= 0) {
      //   await handler.sendMessage(
      //     channelId,
      //     `❌ Invalid amount. Usage: /test_bridge 0.01`,
      //     { threadId },
      //   );
      //   return;
      // }
      // // Get user's wallet
      // const userWallet = await getSmartAccountFromUserId(bot, { userId });
      // if (!userWallet) {
      //   await handler.sendMessage(
      //     channelId,
      //     `❌ Couldn't get your wallet address.`,
      //     { threadId },
      //   );
      //   return;
      // }
      // await handler.sendMessage(
      //   channelId,
      //   `🌉 Starting bridge test for ${amountEth} ETH...\n\nWallet: ${userWallet}`,
      //   { threadId },
      // );
      // await testBridge(
      //   handler,
      //   channelId,
      //   threadId,
      //   userId,
      //   userWallet,
      //   amountEth,
      // );
    }
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

  // TOP-LEVEL LOGGING: Log ALL interaction responses
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
    console.log(" Request ID:", tx.requestId);
    console.log(" TX Hash:", tx.txHash);
    console.log(" TX Hash exists:", !!tx.txHash);
    console.log(" TX Hash length:", tx.txHash?.length);
  }
  console.log("========================================\n");

  const userState = await getUserState(userId);

  // if (response.payload.content.case === "transaction") {
  //   const tx = response.payload.content.value;
  //   if (tx.requestId.startsWith("test_bridge:")) {
  //     await testBridgeTransaction(handler, event, tx);
  //   }
  // }

  if (!userState?.pendingCommand) {
    await handler.sendMessage(
      channelId,
      "Sorry, I lost track of what we were doing. Please start again.",
    );
    return;
  }

  const userTownWallet = await getSmartAccountFromUserId(bot, {
    userId: userId as `0x${string}`,
  });
  switch (response.payload.content.case) {
    case "form": {
      const form = response.payload.content.value;

      if (form.requestId.startsWith("confirm_commit")) {
        const confirmForm = form.requestId.startsWith("confirm_commit") && form;
        await confirmCommit(
          handler,
          event,
          confirmForm,
          userState,
          userTownWallet,
        );

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

        await confirmRegister(
          handler,
          event,
          confirmForRegister,
          userState,
          userTownWallet,
        );
        return;
      }

      if (form.requestId.startsWith("continue_after_bridge")) {
        const bridgeForm =
          form.requestId.startsWith("continue_after_bridge") && form;

        await continueAfterBridge(
          handler,
          event,
          bridgeForm,
          userState,
          userTownWallet,
        );
        return;
      }

      if (form.requestId.startsWith("wallet_select:")) {
        const walletSelectForm =
          form.requestId.startsWith("wallet_select") && form;

        await walletSelection(handler, event, walletSelectForm, userState);

        return;
      }
      break;
    }

    case "transaction": {
      const tx = response.payload.content.value;

      // ENHANCED LOGGING: Transaction response details
      console.log("=== TRANSACTION RESPONSE IN BOT.TS ===");
      console.log(
        "Response payload content case:",
        response.payload.content.case,
      );
      console.log("Extracted tx object:", JSON.stringify(tx, null, 2));
      console.log("Transaction fields:", {
        requestId: tx.requestId,
        txHash: tx.txHash,
        txHashExists: "txHash" in tx,
        txHashType: typeof tx.txHash,
        txHashValue: tx.txHash,
      });
      console.log("Full response structure:", {
        payload: {
          content: {
            case: response.payload.content.case,
            value: response.payload.content.value,
          },
        },
      });
      console.log("======================================");

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
