import type { BotHandler, FlattenedFormComponent } from "@towns-protocol/bot";
import { formatEther } from "viem";
import { formatPhase1Summary } from "../api";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  createRegistrationFlow,
  getUserState,
  hasAnyActiveFlow,
  setActiveFlow,
  setUserPendingCommand,
} from "../db";
import {
  checkAvailability,
  estimateRegistrationCost,
  prepareRegistration,
} from "../services/ens";
import { metrics } from "../services/metrics/metrics";
import type { EOAWalletCheckResult, RegisterCommand } from "../types";
import {
  checkAllEOABalances,
  filterEOAs,
  formatAddress,
  formatAllWalletBalances,
} from "../utils";
import { determineWaitingFor, sendBotMessage } from "./handle_message_utils";

export async function handleRegisterCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: RegisterCommand,
) {
  if (command.action !== "register") {
    return;
  }

  await metrics.trackCommand("register", userId, {
    name: command.name,
    duration: command.duration.toString(),
  });

  await metrics.trackEvent("registration_started", {
    userId,
    name: command.name,
  });

  const { name, duration } = command;

  const existingState = await getUserState(userId);
  const existingFlow = await hasAnyActiveFlow(userId);

  if (existingState?.pendingCommand || existingFlow.hasFlow) {
    console.log("Found existing state, clearing:", {
      hasPendingCommand: !!existingState?.pendingCommand,
      hasActiveFlow: existingFlow.hasFlow,
      flowThreadId: existingFlow.threadId,
    });

    await clearUserPendingCommand(userId);
    if (existingFlow.hasFlow && existingFlow.threadId) {
      await clearActiveFlow(userId, existingFlow.threadId);
    }
    console.log("✅ State cleanup complete, starting fresh registration");
  }

  // Check availability (returns array for backward compat, but we only use first item)
  const check = await checkAvailability(name);

  if (!check.success) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "Sorry, I couldn't check that name right now.",
    );
    return;
  }

  // Get the single result
  const nameCheck = check.data.values[0];

  if (!nameCheck.isAvailable) {
    const ownerDisplay = nameCheck.owner
      ? formatAddress(nameCheck.owner)
      : "unknown";

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **${nameCheck.name}** is already registered.\n\n` +
        `👤 Owner: \`${ownerDisplay}\`\n\n` +
        `Would you like to check a different name?`,
    );
    return;
  }

  // Check duration
  if (!duration) {
    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      determineWaitingFor(command),
    );

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `**${name}** is available! 🎉\n\nHow many years would you like to register it for?`,
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `duration_form:${threadId}`,
        title: "Registration Duration",
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

  // Check wallets
  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    "🔍 Checking your connected wallets...",
  );

  const filteredEOAs = await filterEOAs(userId as `0x${string}`);

  if (filteredEOAs.length === 0) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "❌ **No EOA wallets found**\n\n" +
        "ENS registration requires an Ethereum wallet (EOA) to sign transactions on Mainnet.\n\n" +
        "Please connect an external wallet (like MetaMask) to your Towns account and try again.",
    );
    return;
  }

  // Estimate costs for single name
  const costEstimate = await estimateRegistrationCost({
    names: [name],
    durationYears: duration,
  });

  const requiredAmount = costEstimate.grandTotalWei;

  const walletCheck = await checkAllEOABalances(
    userId as `0x${string}`,
    requiredAmount,
  );

  await setUserPendingCommand(
    userId,
    threadId,
    channelId,
    command,
    "wallet_selection",
  );

  // ---- Only one EOA ----
  if (filteredEOAs.length === 1) {
    const wallet = walletCheck.wallets[0];

    // Sufficient L1 balance - proceed directly
    if (wallet.l1Balance >= requiredAmount) {
      await proceedWithRegistration(
        handler,
        channelId,
        threadId,
        userId,
        command,
        wallet.address,
        walletCheck,
      );
      return;
    }

    // Check if can bridge from L2
    const bridgeBuffer = (requiredAmount * 105n) / 100n;
    if (wallet.l2Balance >= bridgeBuffer) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `💰 **Wallet Balance Check**\n\n` +
          `**${formatAddress(wallet.address)}**\n` +
          `• Mainnet: ${Number(wallet.l1BalanceEth).toFixed(4)} ETH\n` +
          `• Base: ${Number(wallet.l2BalanceEth).toFixed(4)} ETH\n\n` +
          `**Required:** ~${formatEther(requiredAmount)} ETH on Mainnet\n\n` +
          `Your Mainnet balance is insufficient, but you have enough ETH on Base to bridge.\n\n` +
          `Would you like to bridge ETH from Base to Mainnet?`,
      );

      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        command,
        "bridge_confirmation",
      );

      // Create registration flow
      const registrationFlow = createRegistrationFlow({
        userId,
        threadId,
        channelId,
        status: "awaiting_wallet",
        data: {
          name,
          costs: costEstimate.costs,
          totalDomainCostWei: costEstimate.totalDomainCostWei,
          totalDomainCostEth: costEstimate.totalDomainCostEth,
          grandTotalWei: costEstimate.grandTotalWei,
          grandTotalEth: costEstimate.grandTotalEth,
          selectedWallet: wallet.address,
          walletCheckResult: walletCheck,
        },
      });
      await setActiveFlow(registrationFlow);

      await handler.sendInteractionRequest(
        channelId,
        {
          type: "form",
          id: `bridge:${userId}:${threadId}`,
          title: "Bridge ETH?",
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

    // Insufficient balance on both chains
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Insufficient Balance**\n\n` +
        `**${formatAddress(wallet.address)}**\n` +
        `• Mainnet: ${Number(wallet.l1BalanceEth).toFixed(4)} ETH\n` +
        `• Base: ${Number(wallet.l2BalanceEth).toFixed(4)} ETH\n\n` +
        `**Required:** ~${formatEther(requiredAmount)} ETH\n\n` +
        `Please fund your wallet with more ETH on either:\n` +
        `• Ethereum Mainnet (to register directly)\n` +
        `• Base (to bridge and then register)`,
    );
    await clearUserPendingCommand(userId);
    return;
  }

  // ---- Multiple EOAs ----
  const balanceSummary = formatAllWalletBalances(
    walletCheck.wallets,
    requiredAmount,
  );

  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `💰 **Select a Wallet for Registration**\n\n` +
      `**Required:** ~${formatEther(requiredAmount)} ETH for **${name}**\n\n` +
      balanceSummary +
      "\n\n" +
      `Please select which wallet to use:`,
  );

  const walletButtons: FlattenedFormComponent[] = walletCheck.wallets
    .filter((wallet) => {
      const l1Sufficient = wallet.l1Balance >= requiredAmount;
      const l2Sufficient = wallet.l2Balance >= (requiredAmount * 105n) / 100n;
      return l1Sufficient || l2Sufficient;
    })
    .map((wallet, index) => {
      const l1Sufficient = wallet.l1Balance >= requiredAmount;
      const statusEmoji = l1Sufficient ? "✅" : "🌉";

      return {
        id: `wallet_${index}:${wallet.address}`,
        type: "button",
        label: `${statusEmoji} ${formatAddress(wallet.address)} (L1: ${Number(wallet.l1BalanceEth).toFixed(3)})`,
      };
    });

  walletButtons.push({
    id: "cancel",
    type: "button",
    label: "❌ Cancel",
  });

  // Create registration flow
  const registrationFlow = createRegistrationFlow({
    userId,
    threadId,
    channelId,
    status: "awaiting_wallet",
    data: {
      name,
      costs: costEstimate.costs,
      totalDomainCostWei: costEstimate.totalDomainCostWei,
      totalDomainCostEth: costEstimate.totalDomainCostEth,
      grandTotalWei: costEstimate.grandTotalWei,
      grandTotalEth: costEstimate.grandTotalEth,
      walletCheckResult: walletCheck,
    },
  });
  await setActiveFlow(registrationFlow);

  await handler.sendInteractionRequest(
    channelId,
    {
      type: "form",
      id: `wallet_select:${threadId}`,
      title: "Select Wallet",
      components: walletButtons,
      recipient: userId as `0x${string}`,
    },
    { threadId },
  );
}

export async function proceedWithRegistration(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: RegisterCommand,
  selectedWallet: `0x${string}`,
  walletCheck: EOAWalletCheckResult,
) {
  try {
    const registration = await prepareRegistration({
      name: command.name,
      owner: selectedWallet,
      durationYears: command.duration,
    });

    const walletInfo = walletCheck.wallets.find(
      (w) => w.address.toLowerCase() === selectedWallet.toLowerCase(),
    );

    if (!walletInfo) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "❌ Wallet not found. Please try again.",
      );
      return;
    }

    // Create registration flow
    const registrationFlow = createRegistrationFlow({
      userId,
      threadId,
      channelId,
      status: "initiated",
      data: {
        ...registration,
        selectedWallet,
        walletCheckResult: walletCheck,
      },
    });
    await setActiveFlow(registrationFlow);

    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      "confirmation",
    );

    const balanceMessage =
      walletInfo.l1Balance >= registration.grandTotalWei
        ? `✅ L1 Balance: ${Number(walletInfo.l1BalanceEth).toFixed(4)} ETH (sufficient)`
        : `⚠️ L1 Balance: ${Number(walletInfo.l1BalanceEth).toFixed(4)} ETH (need bridging)`;

    const summary = formatPhase1Summary(registration, command.duration);

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `${summary}\n\n` +
        `💰 **Wallet:** ${formatAddress(selectedWallet)}\n` +
        `${balanceMessage}\n\n` +
        `⚠️ **Note:** ENS registration happens on Ethereum Mainnet (L1). \n\n` +
        `Make sure to select the correct wallet when approving transactions. \n\n`,
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `confirm_commit:${threadId}`,
        title: "Confirm Registration: Step 1 of 2",
        components: [
          {
            id: "confirm",
            type: "button",
            label: "✅ Start Registration",
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
  } catch (e) {
    console.error("Error preparing registration:", e);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "Something went wrong. Please try again.",
    );
  }
}
