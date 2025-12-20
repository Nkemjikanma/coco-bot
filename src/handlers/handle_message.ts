import { BotHandler } from "@towns-protocol/bot";
import { coco_parser, validate_parse } from "../ai";
import {
  ApiResponse,
  checkNames,
  NameCheckData,
  getExpiry,
  ExpiryData,
  // getHistory,
  HistoryData,
  getENSPortfolio,
  PortfolioData,
  formatCheckResponse,
  formatExpiryResponse,
  formatHistoryResponse,
  formatPortfolioResponse,
} from "../api";
import {
  appendMessageToSession,
  getRecentMessages,
  getUserState,
  setUserPendingCommand,
  clearUserPendingCommand,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  updateUserLocation,
  describePendingCommand,
} from "../db";

import {
  EventType,
  OnMessageEventType,
  QuestionCommand,
  PendingCommand,
  ParsedCommand,
} from "../types";

import { handleQuestionCommand } from "../ai";

import {
  formatRustPayload,
  determineWaitingFor,
  extractMissingInfo,
  getHelpMessage,
  getWaitingForMessage,
} from "./handle_message_utils";
import {
  getUserPorfolio,
  checkAvailability,
  checkExpiry,
  getHistory,
} from "../services/ens";

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
      content: slashEvent.command + " " + slashEvent.args.join(" "),
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
    const parserResult = await coco_parser(content, recentMessages);

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

async function handlePendingCommandResponse(
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
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "No problem! Let me know if you want to do something else. 👋",
    );
    return;
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

// send message and store in session
async function sendBotMessage(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  message: string,
): Promise<void> {
  await handler.sendMessage(channelId, message, { threadId });

  await appendMessageToSession(threadId, userId, {
    eventId: `bot-${Date.now()}`,
    content: message,
    timestamp: Date.now(),
    role: "assistant",
  });
}

async function executeValidCommand(
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

    // if (!historyResult.success) {
    //   await sendBotMessage(
    //     handler,
    //     channelId,
    //     threadId,
    //     userId,
    //     "Sorry, I couldn't check history infor on that name right now.",
    //   );

    //   return;
    // }

    const historyData = formatHistoryResponse(command.names[0], historyResult);
    await sendBotMessage(handler, channelId, threadId, userId, historyData);

    return;
  }

  if (command.action === "portfolio") {
    // const portfolioResult: ApiResponse<PortfolioData> = await getENSPortfolio(
    //   command.address,
    // );
    const portfolioResult: PortfolioData = await getUserPorfolio(
      command.address,
    );

    // if (!portfolioResult.success) {
    //   await sendBotMessage(
    //     handler,
    //     channelId,
    //     threadId,
    //     userId,
    //     "Sorry, I couldn't check portfolio info on that address right now.",
    //   );

    //   return;
    // }

    const portfolioData = formatPortfolioResponse(
      command.address,
      portfolioResult,
    );

    await sendBotMessage(handler, channelId, threadId, userId, portfolioData);

    return;
  }

  // const response = formatRustPayload(command);
  // await sendBotMessage(handler, channelId, threadId, userId, response);
}
