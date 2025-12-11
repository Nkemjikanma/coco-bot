import { BotHandler, BasePayload } from "@towns-protocol/bot";
import { handle_slash_message } from "./message_handler";
import { appendMessageToSession, getRecentMessages } from "../db";
import { EventType } from "../types";

export async function register_handler(
  handler: BotHandler,
  payload: EventType,
) {
  const currentTime = new Date().toLocaleString();

  const threadId = payload.threadId || payload.eventId;
  const content = payload.args.join(" ");

  const parsed = await handle_slash_message(handler, payload);

  if (parsed.needsClarification) {
    const clarificationQuestion =
      parsed.clarificationQuestion ||
      "I'm not sure what you mean. Can you clarify?";

    await appendMessageToSession(threadId, payload.userId, {
      eventId: `bot-${Date.now()}`,
      content: clarificationQuestion,
      timestamp: Date.now(),
      role: "assistant",
    });

    handler.sendMessage(payload.channelId, clarificationQuestion, {
      threadId,
    });
  }

  switch (parsed.action) {
    case "register": {
      // Execute command

      // const result = await executeCommand(parsed, userId);
      const result: string = "";

      // Store bot response
      await appendMessageToSession(threadId, payload.userId, {
        eventId: `bot-${Date.now()}`,
        content: "Success",
        timestamp: Date.now(),
        role: "assistant",
      });

      // treat result response, add basescan link etc
      // reply with result to user in channel
      handler.sendMessage(
        payload.channelId,
        "If we got here, then we were successful",
        {
          threadId,
        },
      );
    }
  }

  await handler.sendMessage(
    payload.channelId,
    `Current time: ${currentTime} ⏰`,
  );
}
