import { OnMessageEventType } from "../types";
import { BotHandler, BasePayload } from "@towns-protocol/bot";
import { appendMessageToSession, getRecentMessages } from "../db";
import { coco_parser } from "../ai";

export async function handle_on_message(
  handler: BotHandler,
  event: OnMessageEventType,
) {
  const threadId = event.threadId || event.eventId;

  await appendMessageToSession(threadId, event.userId, {
    eventId: event.eventId,
    content: event.message,
    timestamp: Date.now(),
    role: "user",
  });

  const recentMessages = await getRecentMessages(threadId, 5);

  const parsed = await coco_parser(event.message, recentMessages);

  if (parsed.needsClarification) {
    const clarificationQuestion =
      parsed.clarificationQuestion ||
      "I'm not sure what you mean. Can you clarify?";

    await appendMessageToSession(threadId, event.userId, {
      eventId: `bot-${Date.now()}`,
      content: clarificationQuestion,
      timestamp: Date.now(),
      role: "assistant",
    });

    handler.sendMessage(event.channelId, clarificationQuestion, {
      threadId,
    });
  }

  switch (parsed.action) {
    case "register": {
      // Execute command

      // const result = await executeCommand(parsed, userId);
      const result: string = "";

      // Store bot response
      await appendMessageToSession(threadId, event.userId, {
        eventId: `bot-${Date.now()}`,
        content: "Success",
        timestamp: Date.now(),
        role: "assistant",
      });

      // treat result response, add basescan link etc
      // reply with result to user in channel
      handler.sendMessage(
        event.channelId,
        "If we got here, then we were successful",
        {
          threadId,
        },
      );
    }
  }
}
