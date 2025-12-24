import { ENS_CONTRACTS } from "../services/ens/constants";
import {
  type BotHandler,
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
  EventType,
  OnMessageEventType,
  ParsedCommand,
  PendingCommand,
  QuestionCommand,
  RegisterCommand,
} from "../types";
import { checkBalance, formatAddress } from "../utils";
import {
  determineWaitingFor,
  extractMissingInfo,
  formatRustPayload,
  getHelpMessage,
  getWaitingForMessage,
  sendBotMessage,
} from "./handle_message_utils";
import { CHAIN_IDS } from "../services/bridge";
import { getBridgeState, setBridgeState } from "../db/bridgeStore";
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
          await handler.sendInteractionRequest(
            channelId,
            {
              case: "form",
              value: {
                id: `confirm_commit:${threadId}`,
                title: "Confirm Registration: Step 1 of 2",
                components: [
                  {
                    id: "confirm",
                    component: {
                      case: "button",
                      value: { label: "✅ Start Registration" },
                    },
                  },
                  {
                    id: "cancel",
                    component: {
                      case: "button",
                      value: { label: "❌ Cancel" },
                    },
                  },
                ],
              },
            },
            hexToBytes(userId as `0x${string}`),
          );

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

      await handler.sendInteractionRequest(
        channelId,
        {
          case: "transaction",
          value: {
            id: commitmentId,
            title: `Commit ENS Registration: ${firstCommitment.name}`,
            content: {
              case: "evm",
              value: {
                chainId: "1",
                to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                value: "0",
                data: commitData,
              },
            },
          },
        },
        hexToBytes(userId as `0x${string}`),
      );

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

  // const response = formatRustPayload(command);
  // await sendBotMessage(handler, channelId, threadId, userId, response);
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
        "Sorry, all provided names are already registered.",
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
          case: "form",
          value: {
            id: `duration_form:${threadId}`,
            title: "Registration Duration",
            components: [
              {
                id: "duration_text_field",
                component: {
                  case: "textInput",
                  value: { placeholder: "Enter years (1-10)..." },
                },
              },
              {
                id: "confirm",
                component: { case: "button", value: { label: "Submit" } },
              },
              {
                id: "cancel",
                component: { case: "button", value: { label: "Cancel" } },
              },
            ],
          },
        },
        hexToBytes(userId as `0x${string}`),
      );
      return;
    }

    // ---- Prepare and show costs ------
    // Towns wallet
    const userTownWallet = await getSmartAccountFromUserId(bot, {
      userId: userId as `0x${string}`,
    });

    if (!userTownWallet) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Couldn't get your wallet address. Please try again.",
      );
      return;
    }

    try {
      const registration = await prepareRegistration({
        names: command.names,
        owner: userTownWallet,
        durationYears: command.duration,
      });

      // checkBalance
      const mainnetBalance = await checkBalance(
        userTownWallet,
        CHAIN_IDS.MAINNET,
        registration.grandTotalWei,
      );

      // Store registration data
      await setPendingRegistration(userId, registration);

      // Store in pending state
      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        command,
        "confirmation",
      );

      console.log("Debugger is here ");
      const balanceMessage = mainnetBalance.sufficient
        ? `✅ Your L1 balance: ${formatEther(mainnetBalance.balance)} ETH (sufficient)`
        : `⚠️ Your L1 balance: ${formatEther(mainnetBalance.balance)} ETH\n\n

        Required: ~${registration.grandTotalEth} ETH\n
        Please ensure you have enough ETH on Ethereum Mainnet.`;

      if (!mainnetBalance.sufficient) {
        await handleBridging(
          handler,
          userTownWallet,
          channelId,
          threadId,
          userId,
          mainnetBalance,
          registration,
          command,
        );

        return;
      }
      const summary = formatPhase1Summary(registration, command.duration);
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `${summary}\n\n💰 **Balance Check**\n

              ${balanceMessage}\n

              ⚠️ **Note:** ENS registration happens on Ethereum Mainnet (L1). You'll need to sign the transaction with your Ethereum wallet.`,
      );

      // Send confirmation interaction
      await handler.sendInteractionRequest(
        channelId,
        {
          case: "form",
          value: {
            id: `confirm_commit:${threadId}`,
            title: "Confirm Registration: Step 1 of 2",
            components: [
              {
                id: "confirm",
                component: {
                  case: "button",
                  value: { label: "✅ Start Registration" },
                },
              },
              {
                id: "cancel",
                component: { case: "button", value: { label: "❌ Cancel" } },
              },
            ],
          },
        },
        hexToBytes(userId as `0x${string}`),
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
    // clear pending command after execution
    // await clearUserPendingCommand(userId);
    return;
  }
}
