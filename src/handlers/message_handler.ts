import { BotHandler, BasePayload } from "@towns-protocol/bot";
import { ChannelMessage_Post_Mention } from "@towns-protocol/proto";
import { coco_parser } from "../ai/index";
import { appendMessageToSession, getRecentMessages } from "../db";

import { EventType } from "../types";

export async function handle_slash_message(
  handler: BotHandler,
  payload: EventType,
) {
  const threadId = payload.threadId || payload.eventId;
  const content = payload.args.join(" ");

  await appendMessageToSession(threadId, payload.userId, {
    eventId: payload.eventId,
    content,
    timestamp: Date.now(),
    role: "user",
  });

  const recentMessages = await getRecentMessages(threadId, 5);

  const parsed = await coco_parser(content, recentMessages);

  return parsed;
}

// TODO: Add channelID or spaceId?
