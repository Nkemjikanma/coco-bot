import { makeTownsBot } from "@towns-protocol/bot";
import commands from "./commands";
import { register_handler, handle_on_message } from "./handlers";
import { sessionExists } from "./db";
import { containsAllKeywords } from "./utils";

export const bot = await makeTownsBot(
  process.env.APP_PRIVATE_DATA!,
  process.env.JWT_SECRET!,
  {
    commands,
  },
);

bot.onSlashCommand("help", async (handler, { channelId }) => {
  await handler.sendMessage(
    channelId,
    "**Available Commands:**\n\n" +
      "• `/help` - Show this help message\n" +
      "• `/time` - Get the current time\n\n" +
      "**Message Triggers:**\n\n" +
      "• Mention me - I'll respond\n" +
      "• React with 👋 - I'll wave back" +
      '• Say "hello" - I\'ll greet you back\n' +
      '• Say "ping" - I\'ll show latency\n' +
      '• Say "react" - I\'ll add a reaction\n',
  );
});

bot.onSlashCommand("register", async (handler, event) => {
  await register_handler(handler, event);
});

bot.onMessage(async (handler, event) => {
  // listen to message if only it mentions bot or is a session thread
  if (event.isMentioned) {
    await handle_on_message(handler, event);
  }
  if (event.threadId) {
    const checkSessionExists = await sessionExists(event.threadId);
    if (checkSessionExists) {
      await handle_on_message(handler, event);
    }
  }

  const isMessageOfInterest = containsAllKeywords(event.message);

  if (isMessageOfInterest) {
    await handle_on_message(handler, event);
  }

  // if (message.includes("coco")) {
  //   await handler.sendMessage(channelId, "Hello there! 👋");
  //   return;
  // }
  // if (message.includes("ping")) {
  //   const now = new Date();
  //   await handler.sendMessage(
  //     channelId,
  //     `Pong! 🏓 ${now.getTime() - createdAt.getTime()}ms`,
  //   );
  //   return;
  // }
  // if (message.includes("react")) {
  //   await handler.sendReaction(channelId, eventId, "👍");
  //   return;
  // }
});

bot.onReaction(async (handler, { reaction, channelId }) => {
  if (reaction === "👋") {
    await handler.sendMessage(channelId, "I saw your wave! 👋");
  }
});
