import type { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getUserState,
  hasAnyActiveFlow,
  setActiveFlow,
  setUserPendingCommand,
} from "../db";
import { createRenewFlow } from "../db/flow.utils";
import { getRenewService } from "../services/ens/renew/renew";
import { metrics } from "../services/metrics/metrics";
import type { RenewCommand } from "../types";
import {
  checkAllEOABalances,
  filterEOAs,
  formatAddress,
  formatDate,
} from "../utils";
import { sendBotMessage } from "./handle_message_utils";

export async function handleRenewCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: RenewCommand,
): Promise<void> {
  const { name, duration } = command;

  // Track command
  await metrics.trackCommand("renew", userId, {
    name,
    duration: duration?.toString() || "unknown",
  });

  // Clear any existing state
  const existingState = await getUserState(userId);
  const existingFlow = await hasAnyActiveFlow(userId);

  if (existingState?.pendingCommand || existingFlow.hasFlow) {
    await clearUserPendingCommand(userId);
    if (existingFlow.hasFlow && existingFlow.threadId) {
      await clearActiveFlow(userId, existingFlow.threadId);
    }
  }

  // Validate duration
  if (!duration || duration < 1 || duration > 10) {
    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      { ...command, action: "renew" },
      "duration",
    );

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `How many years would you like to renew **${name}** for?\n\n` +
        `Please enter a number between 1 and 10.`,
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `renew_duration:${threadId}`,
        title: "Renewal Duration",
        components: [
          {
            id: "duration_text_field",
            type: "textInput",
            placeholder: "Enter years (1-10)...",
          },
          {
            id: "confirm",
            type: "button",
            label: "Submit",
          },
          {
            id: "cancel",
            type: "button",
            label: "Cancel",
          },
        ],
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );
    return;
  }

  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `🔍 Checking ownership and renewal cost for **${name}**...`,
  );

  try {
    // Get user's EOA wallets
    const userWallets = await filterEOAs(userId as `0x${string}`);

    if (userWallets.length === 0) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **No EOA wallets found**\n\n` +
          `You need an EOA wallet (like MetaMask) connected to renew names.\n` +
          `Please connect an external wallet and try again.`,
      );
      return;
    }

    // Prepare renewal
    const renewService = getRenewService();
    const prepResult = await renewService.prepareRenewal({
      name,
      durationYears: duration,
      userWallets,
    });

    if (!prepResult.success || !prepResult.data) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Cannot Renew**\n\n${prepResult.error}`,
      );
      return;
    }

    const renewal = prepResult.data;

    // Check wallet balances
    const walletCheck = await checkAllEOABalances(
      userId as `0x${string}`,
      renewal.recommendedValueWei,
    );

    const ownerWalletInfo = walletCheck.wallets.find(
      (w) => w.address.toLowerCase() === renewal.ownerWallet.toLowerCase(),
    );

    if (!ownerWalletInfo) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Wallet Error**\n\n` +
          `Could not find balance info for ${formatAddress(renewal.ownerWallet)}.`,
      );
      return;
    }

    // Check if sufficient balance on L1
    const hasL1Balance =
      ownerWalletInfo.l1Balance >= renewal.recommendedValueWei;
    const canBridgeL2 =
      ownerWalletInfo.l2Balance >= (renewal.recommendedValueWei * 110n) / 100n;

    // Track renewal started
    await metrics.trackEvent("renew_started", {
      userId,
      name: renewal.name,
      duration: duration.toString(),
    });

    // Create flow
    const flow = createRenewFlow({
      userId,
      threadId,
      channelId,
      status: "initiated",
      data: {
        name: renewal.name,
        labelName: renewal.labelName,
        durationYears: renewal.durationYears,
        durationSeconds: renewal.durationSeconds,
        totalCostWei: renewal.totalCostWei,
        totalCostEth: renewal.totalCostEth,
        recommendedValueWei: renewal.recommendedValueWei,
        recommendedValueEth: renewal.recommendedValueEth,
        currentExpiry: renewal.currentExpiry.toISOString(),
        newExpiry: renewal.newExpiry.toISOString(),
        ownerWallet: renewal.ownerWallet,
        isWrapped: renewal.isWrapped,
      },
    });

    await setActiveFlow(flow);

    // Display renewal summary
    const balanceStatus = hasL1Balance
      ? `✅ L1 Balance: ${Number(ownerWalletInfo.l1BalanceEth).toFixed(4)} ETH (sufficient)`
      : `⚠️ L1 Balance: ${Number(ownerWalletInfo.l1BalanceEth).toFixed(4)} ETH (insufficient)`;

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `📋 **Renewal Summary**\n\n` +
        `• **Name:** ${renewal.name}\n` +
        `• **Duration:** ${renewal.durationYears} year${renewal.durationYears > 1 ? "s" : ""}\n` +
        `• **Cost:** ${renewal.totalCostEth} ETH (~$${(Number(renewal.totalCostEth) * 2500).toFixed(2)})\n\n` +
        `📅 **Expiry Dates**\n` +
        `• Current: ${formatDate(renewal.currentExpiry)}\n` +
        `• After renewal: ${formatDate(renewal.newExpiry)}\n\n` +
        `💰 **Wallet:** ${formatAddress(renewal.ownerWallet)}\n` +
        `${balanceStatus}`,
    );

    // Handle insufficient balance
    if (!hasL1Balance) {
      if (canBridgeL2) {
        await setUserPendingCommand(
          userId,
          threadId,
          channelId,
          command,
          "bridge_confirmation",
        );

        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          `\nYou have enough ETH on Base to bridge. Would you like to bridge first?`,
        );

        await handler.sendInteractionRequest(
          channelId,
          {
            type: "form",
            id: `renew_bridge:${userId}:${threadId}`,
            title: "Bridge ETH for Renewal?",
            components: [
              {
                id: "bridge",
                type: "button",
                label: "🌉 Bridge from Base",
              },
              {
                id: "cancel",
                type: "button",
                label: "❌ Cancel",
              },
            ],
            recipient: userId as `0x${string}`,
          },
          { threadId },
        );
        return;
      }

      // Truly insufficient funds
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `\n❌ **Insufficient Funds**\n\n` +
          `You need ~${renewal.recommendedValueEth} ETH on Mainnet to renew.\n` +
          `Please fund your wallet and try again.`,
      );
      await clearActiveFlow(userId, threadId);
      return;
    }

    // Sufficient balance - proceed to confirmation
    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      "confirmation",
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `renew_confirm:${userId}:${threadId}`,
        title: "Confirm Renewal",
        components: [
          {
            id: "confirm",
            type: "button",
            label: `✅ Renew for ${renewal.totalCostEth} ETH`,
          },
          {
            id: "cancel",
            type: "button",
            label: "❌ Cancel",
          },
        ],
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );
  } catch (error) {
    console.error("Error in renew command:", error);

    await metrics.trackEvent("error_occurred", {
      userId,
      command: "renew",
      error: error instanceof Error ? error.message : "Unknown error",
    });

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ An unexpected error occurred. Please try again later.`,
    );
  }
}
