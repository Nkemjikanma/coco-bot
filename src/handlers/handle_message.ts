import { BotHandler } from "@towns-protocol/bot";
import { coco_parser, validate_parse } from "../ai";
import {
  appendMessageToSession,
  getRecentMessages,
  getConversationState,
  setPendingCommand,
  clearPendingCommand,
} from "../db";

import {
  EventType,
  OnMessageEventType,
  ConversationState,
  QuestionCommand,
} from "../types";

import { handleQuestionCommand } from "../ai";

import {
  formatRustPayload,
  determineWaitingFor,
  extractMissingInfo,
  getHelpMessage,
} from "./handle_message_utils";

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
      content: slashEvent.args.join(" "),
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
    // check if user is responding to pending command
    const conversationState = await getConversationState(threadId);

    if (conversationState?.pendingCommand) {
      await handlePendingCommandResponse(
        handler,
        channelId,
        threadId,
        userId,
        content,
        conversationState,
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
      pendingCommand: conversationState?.pendingCommand,
    });

    if (!validation.valid) {
      // if command is not valid - store pending command and ask clarification
      await setPendingCommand(
        threadId,
        userId,
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
    await clearPendingCommand(threadId);

    const command = validation.command;

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

    const response = formatRustPayload(command);
    await sendBotMessage(handler, channelId, threadId, userId, response);
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
  conversationState: ConversationState,
): Promise<void> {
  const pending = conversationState.pendingCommand!;

  // Check for change of mind
  const lowerContent = content.toLowerCase();
  if (
    lowerContent.includes("cancel") ||
    lowerContent.includes("nevermind") ||
    lowerContent.includes("never mind") ||
    lowerContent.includes("stop")
  ) {
    await clearPendingCommand(threadId);
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
    // attempts at clarification is much
    if (pending.attemptCount >= 3) {
      await clearPendingCommand(threadId);
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I'm having a bit of trouble understanding. Let's start fresh! What would you like to do? 🔄",
      );

      return;
    }

    // update pending command
    await setPendingCommand(
      threadId,
      userId,
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

  // valid command! clear pending and show rust payload
  await clearPendingCommand(threadId);

  const response = formatRustPayload(validation.command);
  await sendBotMessage(handler, channelId, threadId, userId, response);
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
