import { BotHandler, FlattenedFormComponent } from "@towns-protocol/bot";
import { RegisterCommand } from "../types";
import { formatEther } from "viem";
import {
  getUserState,
  hasAnyActiveFlow,
  clearUserPendingCommand,
  clearActiveFlow,
  setUserPendingCommand,
  createRegistrationFlow,
  setActiveFlow,
} from "../db";
import { checkAvailability, estimateRegistrationCost } from "../services/ens";
import {
  formatAddress,
  filterEOAs,
  checkAllEOABalances,
  formatAllWalletBalances,
} from "../utils";
import { proceedWithRegistration } from "./handle_message";
import { sendBotMessage, determineWaitingFor } from "./handle_message_utils";

export async function handleRegisterCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: RegisterCommand,
) {
  if (command.action === "register") {
    const check = await checkAvailability(command.names);

    // ✅ CLEANUP: Clear any stale state using new API
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
    } else {
      console.log(
        "No existing state found, proceeding with fresh registration",
      );
    }

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

    const takenNames = check.data.values.filter((n) => !n.isAvailable);
    const availableNames = check.data.values.filter((n) => n.isAvailable);

    if (takenNames.length > 0 && availableNames.length > 0) {
      const taken = takenNames
        .map((n) => {
          return `**${n.name}** is registered to ${formatAddress(n.owner as string)}`;
        })
        .join("\n");

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `**These names are already taken:**\n\n${taken}\n\nProceeding with available names...`,
      );
      command.names = availableNames.map((n) => n.name);
    }

    if (takenNames.length > 0 && availableNames.length === 0) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "❌ Sorry, all provided names are already registered.",
      );
      return;
    }

    if (!command.duration) {
      const pendingCommandWithAvailableNames: RegisterCommand = {
        ...command,
        names: availableNames.map((n) => n.name),
      };
      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        pendingCommandWithAvailableNames,
        determineWaitingFor(pendingCommandWithAvailableNames),
      );

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Duration hasn't been set for the names. ",
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

    const costEstimate = await estimateRegistrationCost({
      names: command.names,
      durationYears: command.duration,
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

        // ✅ Create registration flow with new API
        const registrationFlow = createRegistrationFlow({
          userId,
          threadId,
          channelId,
          status: "awaiting_wallet",
          data: {
            names: [],
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
          `Please fund your wallet with more ETH on either:\n\n` +
          `• Ethereum Mainnet (to register directly)\n\n` +
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
        `**Required:** ~${formatEther(requiredAmount)} ETH for ${command.names.join(", ")}\n\n` +
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

    // ✅ Create registration flow with new API
    const registrationFlow = createRegistrationFlow({
      userId,
      threadId,
      channelId,
      status: "awaiting_wallet",
      data: {
        names: [],
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
    return;
  }
}
