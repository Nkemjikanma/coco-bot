import { makeTownsBot } from "@towns-protocol/bot";
import commands from "./commands";
import { sessionExists } from "./db";
import { handleOnMessage, handleSlashCommand } from "./handlers";

// import { handleInteractionResponse } from "./handlers";

const APP_DATA = process.env.APP_PRIVATE_DATA;
const SECRET = process.env.JWT_SECRET;

if (!APP_DATA || !SECRET) {
  throw new Error("Missing APP_DATA or SECRET information. Fix env");
}
export const bot = await makeTownsBot(APP_DATA, SECRET, {
  commands,
});

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
