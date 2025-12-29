import { ENS_CONTRACTS } from "../services/ens/constants";
import {
  type BotHandler,
  FlattenedFormComponent,
  getSmartAccountFromUserId,
} from "@towns-protocol/bot";
import { formatEther, hexToBytes, isAddress, parseEther } from "viem";
import { coco_parser, handleQuestionCommand, validate_parse } from "../ai";
import {
  type ApiResponse,
  type ExpiryData,
  formatCheckResponse,
  formatExpiryResponse,
  formatHistoryResponse,
  formatPortfolioResponse,
  type HistoryData,
  type NameCheckResponse,
  type PortfolioData,
  formatPhase1Summary,
  formatPhase2Summary,
} from "../api";
import { bot } from "../bot";
import {
  appendMessageToSession,
  clearUserPendingCommand,
  describePendingCommand,
  getRecentMessages,
  getUserState,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  setUserPendingCommand,
  updateUserLocation,
  setPendingRegistration,
  clearPendingRegistration,
  getPendingRegistration,
  updatePendingRegistration,
} from "../db";
import {
  checkAvailability,
  checkExpiry,
  getHistory,
  getUserPorfolio,
  prepareRegistration,
  encodeCommitData,
} from "../services/ens";
import type {
  EOAWalletCheckResult,
  EventType,
  OnMessageEventType,
  ParsedCommand,
  PendingCommand,
  QuestionCommand,
  RegisterCommand,
} from "../types";
import {
  checkAllEOABalances,
  checkBalance,
  filterEOAs,
  formatAddress,
  formatAllWalletBalances,
} from "../utils";
import {
  determineWaitingFor,
  extractMissingInfo,
  formatRustPayload,
  getHelpMessage,
  getWaitingForMessage,
  sendBotMessage,
} from "./handle_message_utils";
import { CHAIN_IDS } from "../services/bridge";
import { clearBridge, getBridgeState, setBridgeState } from "../db/bridgeStore";
import { handleBridging } from "../services/bridge/bridgeUtils";

type UnifiedEvent = {
  channelId: string;
  userId: string;
  eventId: string;
  threadId: string | undefined;
  content: string; // The actual message content
  source: "slash_command" | "natural_language";
};

// Normalize slash command and natural language into a unified format
function normalizeEvent(
  event: EventType | OnMessageEventType,
  source: "slash_command" | "natural_language",
): UnifiedEvent {
  if (source === "slash_command") {
    const slashEvent = event as EventType;
    return {
      channelId: slashEvent.channelId,
      userId: slashEvent.userId,
      eventId: slashEvent.eventId,
      threadId: slashEvent.threadId,
      content: `${slashEvent.command} ${slashEvent.args.join(" ")}`,
      source,
    };
  } else {
    const messageEvent = event as OnMessageEventType;
    return {
      channelId: messageEvent.channelId,
      userId: messageEvent.userId,
      eventId: messageEvent.eventId,
      threadId: messageEvent.threadId,
      content: messageEvent.message,
      source,
    };
  }
}

/**
 * Handler for onSlashCommand
 */
export async function handleSlashCommand(
  handler: BotHandler,
  event: EventType,
): Promise<void> {
  await handleMessage(handler, event, "slash_command");
}

/**
 * Handler for onMessage
 */
export async function handleOnMessage(
  handler: BotHandler,
  event: OnMessageEventType,
): Promise<void> {
  await handleMessage(handler, event, "natural_language");
}

/**
 * check if user is responding to a pending command - clarification
 * parse the message to ai
 * validate the parsed command
 * if invalid, ask for clarification and store pending command
 * if valid, format the payload for rust and send confirmation
 * */
export async function handleMessage(
  handler: BotHandler,
  event: EventType | OnMessageEventType,
  source: "slash_command" | "natural_language",
): Promise<void> {
  const unified = normalizeEvent(event, source);
  const { channelId, userId, eventId, content } = unified;
  const threadId = unified.threadId || eventId;

  // Skip empty messages
  if (!content || content.trim() === "") {
    return;
  }

  // get user's Towns wallet address when they don't pass wallet address explicitly
  let walletAdd: `0x${string}` | null;
  const walletAddressInContent = content.split(" ").filter((c) => isAddress(c));

  if (walletAddressInContent.length === 0) {
    walletAdd = await getSmartAccountFromUserId(bot, {
      userId: event.userId,
    });
  } else {
    walletAdd = walletAddressInContent[0];
  }

  // store this new message in user's session
  await appendMessageToSession(threadId, userId, {
    eventId,
    content,
    timestamp: Date.now(),
    role: "user",
  });

  try {
    // check if user has another conversation going on elsewhere
    const elsewhereCheck = await hasPendingCommandElsewhere(userId, threadId);

    if (elsewhereCheck.pendingThreadId && elsewhereCheck.pendingCommand) {
      // Check if user wants to continue here or cancel
      const lowerContent = content.toLowerCase();

      if (
        lowerContent.includes("continue here") ||
        lowerContent.includes("yes")
      ) {
        // Move pending command to this thread
        await movePendingCommandToThread(userId, threadId, channelId);

        const pending = elsewhereCheck.pendingCommand;

        if (pending.waitingFor === "confirmation") {
          const registration = await getPendingRegistration(userId);

          if (!registration.success || !registration.data) {
            await sendBotMessage(
              handler,
              channelId,
              threadId,
              userId,
              "Your registration data expired. Please start again with `/register`.",
            );
            await clearUserPendingCommand(userId);
            return;
          }

          const message = getWaitingForMessage(pending);
          await sendBotMessage(
            handler,
            channelId,
            threadId,
            userId,
            `Great! Continuing here.\n\n${message}`,
          );

          // Send the confirmation interaction
          await handler.sendInteractionRequest(channelId, {
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
          });

          return;
        }

        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "Great! Continuing here. " +
            getWaitingForMessage(elsewhereCheck.pendingCommand),
        );
        return;
      } else if (
        lowerContent.includes("start fresh") ||
        lowerContent.includes("cancel") ||
        lowerContent.includes("no")
      ) {
        // Clear the old pending command
        await clearUserPendingCommand(userId);
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "No problem! Starting fresh. What would you like to do? 🆕",
        );
        return;
      } else {
        // Ask user what they want to do
        const description = describePendingCommand(
          elsewhereCheck.pendingCommand,
        );
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          `👋 Hey! I noticed you started something in another chat:\n\n${description}\n\n` +
            `Would you like to:\n` +
            `• **"Continue here"** - Pick up where you left off\n` +
            `• **"Start fresh"** - Cancel that and start something new`,
        );
        return;
      }
    }

    // Step 2: Check if user is responding to a pending command in THIS thread
    const userState = await getUserState(userId);

    if (userState?.pendingCommand && userState.activeThreadId === threadId) {
      const lowerContent = content.toLowerCase().trim();
      const isNewCommand =
        lowerContent.startsWith("register ") ||
        lowerContent.startsWith("check ") ||
        lowerContent.startsWith("expiry ") ||
        lowerContent.startsWith("history ") ||
        lowerContent.startsWith("portfolio ") ||
        lowerContent.startsWith("/");

      if (isNewCommand) {
        // Clear pending state and process as new command
        await clearUserPendingCommand(userId);
        await clearPendingRegistration(userId);
        await clearBridge(userId, threadId);
        // Fall through to normal parsing below
      } else {
        await handlePendingCommandResponse(
          handler,
          channelId,
          threadId,
          userId,
          content,
          userState.pendingCommand,
        );
        return;
      }
    }

    // Parse the message using Claude
    const recentMessages = await getRecentMessages(threadId, 5);
    const parserResult = await coco_parser(
      `${content} ${walletAdd}`,
      recentMessages,
    );

    if (!parserResult.success) {
      // Parser error - send user-friendly message
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        parserResult.userMessage,
      );
      return;
    }

    // Validate the parsed command
    const validation = validate_parse(parserResult.parsed, {
      recentMessages: recentMessages.map((m) => m.content),
      pendingCommand: userState?.pendingCommand,
    });

    if (!validation.valid) {
      // Need more info - store pending command with user state
      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        validation.partial,
        determineWaitingFor(validation.partial),
      );

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        validation.question,
      );
      return;
    }

    // Valid command! Clear any pending state and show Rust payload
    await clearUserPendingCommand(userId);
    await updateUserLocation(userId, threadId, channelId);

    const command = validation.command;

    await executeValidCommand(handler, channelId, threadId, userId, command);
  } catch (error) {
    console.error("Error in message handler:", error);
    const errorMsg =
      "Oops! Something went wrong on my end. Can you try that again? 🔧";
    await sendBotMessage(handler, channelId, threadId, userId, errorMsg);
  }
}

export async function handlePendingCommandResponse(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  content: string,
  pending: PendingCommand,
): Promise<void> {
  // Check for change of mind
  const lowerContent = content.toLowerCase();
  if (
    lowerContent.includes("cancel") ||
    lowerContent.includes("nevermind") ||
    lowerContent.includes("never mind") ||
    lowerContent.includes("stop")
  ) {
    await clearUserPendingCommand(userId);
    await clearPendingRegistration(userId);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "No problem! Let me know if you want to do something else. 👋",
    );
    return;
  }

  if (pending.waitingFor === "confirmation") {
    if (lowerContent.includes("confirm") || lowerContent.includes("yes")) {
      // Get the pending registration data
      const registration = await getPendingRegistration(userId);

      if (!registration.success || !registration.data) {
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "Your registration data expired. Please start again.",
        );
        await clearUserPendingCommand(userId);
        return;
      }

      // Send the commit transaction directly
      const regData = registration.data;
      const firstCommitment = regData.names[0];
      const commitData = encodeCommitData(firstCommitment.commitment);
      const commitmentId = `commit:${userId}:${Date.now()}`;

      await updatePendingRegistration(userId, { phase: "commit_pending" });

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "🚀 Starting registration...\n\nPlease approve the commit transaction.",
      );

      await handler.sendInteractionRequest(channelId, {
        type: "transaction",
        id: commitmentId,
        title: `Commit ENS Registration: ${firstCommitment.name}`,
        tx: {
          chainId: "1",
          to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
          value: "0",
          data: commitData,
          signerWallet: registration.data.selectedWallet || undefined,
        },
        recipient: userId as `0x${string}`,
      });

      return;
    } else {
      // User said something other than confirm/cancel
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Please say **confirm** to proceed with the registration, or **cancel** to stop.",
      );
      return;
    }
  }

  const updated = extractMissingInfo(
    pending.partialCommand,
    content,
    pending.waitingFor,
  );

  // validate updated command
  const validation = validate_parse(updated);

  if (!validation.valid) {
    // Still missing info or invalid
    if (pending.attemptCount >= 3) {
      await clearUserPendingCommand(userId);
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I'm having a bit of trouble understanding. Let's start fresh! What would you like to do? 🔄",
      );
      return;
    }

    // Update pending command with incremented attempt count
    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      validation.partial,
      determineWaitingFor(validation.partial),
    );

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      validation.question,
    );
    return;
  }

  // Valid command! Clear pending and show Rust payload
  await clearUserPendingCommand(userId);
  await updateUserLocation(userId, threadId, channelId);

  const command = validation.command;

  await executeValidCommand(handler, channelId, threadId, userId, command);
}

export async function executeValidCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: ParsedCommand,
): Promise<void> {
  // Handle question and help commands
  // Questions - answer directly, don't send to Rust
  if (command.action === "question") {
    const answer = await handleQuestionCommand(command as QuestionCommand);
    await sendBotMessage(handler, channelId, threadId, userId, answer);
    return;
  }

  // Help - show help message
  if (command.action === "help") {
    const helpMessage = getHelpMessage();
    await sendBotMessage(handler, channelId, threadId, userId, helpMessage);
    return;
  }

  if (command.action === "check") {
    // const checkResult: ApiResponse<NameCheckData> = await checkNames(
    //   command.names,
    // );
    const checkResult = await checkAvailability(command.names);
    if (!checkResult.success) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Sorry, I couldn't check that name right now.",
      );

      return;
    }

    // TODO: Format check message for bot
    const checkData = formatCheckResponse(checkResult.data);
    await sendBotMessage(handler, channelId, threadId, userId, checkData);

    return;
  }

  if (command.action === "expiry") {
    const expiryResult: ApiResponse<ExpiryData> = await checkExpiry(
      command.names,
    );

    if (!expiryResult.success) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Sorry, I couldn't check expiry infor on that name right now.",
      );

      return;
    }
    const expiryData = formatExpiryResponse(expiryResult.data);
    await sendBotMessage(handler, channelId, threadId, userId, expiryData);

    return;
  }

  if (command.action === "history") {
    if (command.names.length > 1) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `I'll get history for just the first name "${command.names[0]}" because the data returned for history is usually long`,
      );
    }

    // const historyResult: ApiResponse<HistoryData> = await getHistory(
    //   command.names[0],
    // );
    const historyResult: HistoryData = await getHistory(command.names[0]);

    const historyData = formatHistoryResponse(command.names[0], historyResult);
    await sendBotMessage(handler, channelId, threadId, userId, historyData);

    return;
  }

  if (command.action === "portfolio") {
    // const portfolioResult: ApiResponse<PortfolioData> = await getENSPortfolio(
    //   command.address,
    // );

    if (command.address === null || !isAddress(command.address)) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Something went wrong and we can't figure out that address. Let's start again.",
      );
    }

    const portfolioResult: PortfolioData | null = await getUserPorfolio(
      command.address,
    );

    if (portfolioResult === null) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Looks like you don't own any. You can always register one",
      );

      return;
    }

    const portfolioData = formatPortfolioResponse(
      command.address,
      portfolioResult,
    );

    await sendBotMessage(handler, channelId, threadId, userId, portfolioData);

    return;
  }

  // handle register, renew, transfer, set
  await handleExecution(handler, channelId, threadId, userId, command);
}

async function handleExecution(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: ParsedCommand,
) {
  if (command.action === "register") {
    const check = await checkAvailability(command.names);

    // CLEANUP: Clear any stale state from previous registration attempts // This ensures each /register command starts with a clean slate console.log(🧹 Cleaning up any existing state for user ${userId} before starting new registration);
    const existingState = await getUserState(userId);
    const existingRegistration = await getPendingRegistration(userId);
    if (existingState?.pendingCommand || existingRegistration.success) {
      console.log("Found existing state, clearing:", {
        hasPendingCommand: !!existingState?.pendingCommand,
        hasPendingRegistration: existingRegistration.success,
        activeThreadId: existingState?.activeThreadId,
      });
      // Clear all user state to prevent conflicts
      await clearUserPendingCommand(userId);
      await clearPendingRegistration(userId);
      // Clear bridge state if it exists (we don't have the threadId, so we'll log it)
      if (existingState?.activeThreadId) {
        await clearBridge(userId, existingState.activeThreadId);
        console.log(
          `Cleared bridge state for threadId: ${existingState.activeThreadId}`,
        );
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

    // get unavailable names
    const takenNames = check.data.values.filter((n) => !n.isAvailable);
    const availableNames = check.data.values.filter((n) => n.isAvailable);

    if (takenNames.length > 0 && availableNames.length > 0) {
      // send message about taken names
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

      await handler.sendInteractionRequest(channelId, {
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
      });
      return;
    }

    // ---- Get connected wallet addresses - EOAs ------
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

    // Get cost estimate (using first EOA as placeholder owner)
    const preliminaryRegistration = await prepareRegistration({
      names: command.names,
      owner: filteredEOAs[0],
      durationYears: command.duration,
    });

    const requiredAmount = preliminaryRegistration.grandTotalWei;

    // Check balances on all EOAs
    const walletCheck = await checkAllEOABalances(
      userId as `0x${string}`,
      requiredAmount,
    );

    // Store command for later use
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

      // Check if L1 has enough
      if (wallet.l1Balance >= requiredAmount) {
        // Sufficient on L1 - proceed directly
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

      const bridgeBuffer = (requiredAmount * 105n) / 100n; // 5% buffer for fees
      if (wallet.l2Balance >= bridgeBuffer) {
        // Ask if user wants to bridge
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
            `Would you like to bridge ETH from Base to Mainnet?
            `,
        );

        // Store wallet selection for bridge flow
        await setUserPendingCommand(
          userId,
          threadId,
          channelId,
          command,
          "bridge_confirmation",
        );

        // Store the selected wallet in registration state
        await setPendingRegistration(userId, {
          ...preliminaryRegistration,
          selectedWallet: wallet.address,
        });

        await handler.sendInteractionRequest(channelId, {
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
        });
        return;
      }

      // Neither L1 nor L2 has enough
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
          `• Base (to bridge and then register)\n\n
          `,
      );
      await clearUserPendingCommand(userId);
      return;
    }

    // ---- SCENARIO 2: Multiple EOAs ----
    // Show wallet selection with balances
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

    // Create buttons for each wallet
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

    // Add cancel button
    walletButtons.push({
      id: "cancel",
      type: "button",
      label: "❌ Cancel",
    });

    // Store wallet check result for later
    await setPendingRegistration(userId, {
      ...preliminaryRegistration,
      walletCheckResult: walletCheck,
    });

    await handler.sendInteractionRequest(channelId, {
      type: "form",
      id: `wallet_select:${threadId}`,
      title: "Select Wallet",
      components: walletButtons,
      recipient: userId as `0x${string}`,
    });
    return;
  }
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
    // Prepare registration with the selected wallet as owner
    const registration = await prepareRegistration({
      names: command.names,
      owner: selectedWallet,
      durationYears: command.duration,
    });

    // Get the wallet's L1 balance
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

    // Store registration data with selected wallet
    await setPendingRegistration(userId, {
      ...registration,
      selectedWallet,
    });

    // Store in pending state
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

    // Send confirmation interaction
    await handler.sendInteractionRequest(channelId, {
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
    });
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
