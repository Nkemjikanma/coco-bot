import { makeTownsBot } from "@towns-protocol/bot";
import commands from "./commands";
import { handleOnMessage, handleSlashCommand } from "./handlers";
import { sessionExists } from "./db";

export const bot = await makeTownsBot(
  process.env.APP_PRIVATE_DATA!,
  process.env.JWT_SECRET!,
  {
    commands,
  },
);

const cocoCommands = [
  "help",
  "check",
  "register",
  "renew",
  "transfer",
  "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  "remind",
  "watch",
] as const;

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    await handleSlashCommand(handler, event);
  });
}

bot.onMessage(async (handler, event) => {
  // if message is from bot, ignore
  if (event.userId === bot.botId) return;

  const shouldRespond = await shouldRespondToMessage(event);

  if (shouldRespond) {
    await handleOnMessage(handler, event);
  }
});

bot.onReaction(async (handler, { reaction, channelId }) => {
  if (reaction === "👋") {
    await handler.sendMessage(channelId, "I saw your wave! 👋");
  }
});

async function shouldRespondToMessage(event: {
  isMentioned: boolean;
  threadId: string | undefined;
  message: string;
}): Promise<boolean> {
  // Always respond if mentioned
  if (event.isMentioned) {
    return true;
  }

  // Respond if in an existing session thread
  if (event.threadId) {
    const hasSession = await sessionExists(event.threadId);
    if (hasSession) {
      return true;
    }
  }

  // Check for ENS-related keywords
  if (containsEnsKeywords(event.message)) {
    return true;
  }

  return false;
}

function containsEnsKeywords(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // ENS-specific keywords
  const ensKeywords = [
    ".eth",
    "ens",
    "register",
    "renew",
    "transfer",
    "domain",
    "check availability",
    "is available",
  ];

  // Bot name
  const botNames = ["coco"];

  const allKeywords = [...ensKeywords, ...botNames];

  return allKeywords.some((keyword) => lowerMessage.includes(keyword));
}
