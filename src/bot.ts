import { makeTownsBot } from "@towns-protocol/bot";
import commands from "./commands";
import { handleOnMessage, handleSlashCommand } from "./handlers";
import { sessionExists } from "./db";
import { containsAllKeywords } from "./utils";

export const bot = await makeTownsBot(
  process.env.APP_PRIVATE_DATA!,
  process.env.JWT_SECRET!,
  {
    commands,
  },
);

const cocoCommands = [
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
// Help command - could use unified handler or keep simple
bot.onSlashCommand("help", async (handler, { channelId }) => {
  await handler.sendMessage(
    channelId,
    "👋 **Hi! I'm Coco, your ENS assistant on Towns.**\n\n" +
      "**You can talk to me naturally!**\n" +
      '_Try: "check if alice.eth is available" or "register bob.eth for 2 years"_' +
      "**But you can also use slash commands, like:**\n\n" +
      "🔍 `/check alice.eth` - Check if a name is available\n" +
      "📝 `/register alice.eth 3` - Register a name for 3 years\n" +
      "🔄 `/renew alice.eth 2` - Renew a name for 2 years\n" +
      "📤 `/transfer alice.eth 0x123...` - Transfer a name\n" +
      "⚙️ `/set alice.eth` - Set records (twitter, address, etc.)\n" +
      "📂 `/portfolio` - View your ENS names\n" +
      "⏰ `/expiry alice.eth` - Check when a name expires\n" +
      "📜 `/history alice.eth` - See registration history\n" +
      "🔔 `/remind alice.eth` - Set renewal reminder\n" +
      "👀 `/watch alice.eth` - Watch for availability\n\n",
  );
});

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
