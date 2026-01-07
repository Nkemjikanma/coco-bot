import type { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getUserState,
  setUserPendingCommand,
} from "../db";
import { sendBotMessage } from "./handle_message_utils";

export const COMPLETION_CONFIG = {
  // Actions that should prompt "anything else?" after completion
  promptAfterCompletion: [
    "register",
    "renew",
    "transfer",
    "subdomain",
    "check",
    "expiry",
    "history",
    "portfolio",
  ],

  // Actions that auto-clear without prompting (quick queries)
  autoClearAfterCompletion: ["help", "question"],

  // Timeout for "anything else?" prompt (5 minutes)
  promptTimeoutMs: 5 * 60 * 1000,
};
/**
 * State to track completion prompts
 */
interface CompletionPromptState {
  userId: string;
  threadId: string;
  channelId: string;
  completedAction: string;
  completedName?: string;
  promptedAt: number;
}

// In-memory store for completion prompts (Show we use Redis?)
export const completionPrompts = new Map<string, CompletionPromptState>();
export function getPromptKey(userId: string, threadId: string): string {
  return `completion:${userId}:${threadId}`;
}

export async function handleCommandCompletion(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  completedAction: string,
  completedName?: string,
): Promise<void> {
  // Check if this action should prompt
  if (COMPLETION_CONFIG.autoClearAfterCompletion.includes(completedAction)) {
    // Quick query - just clear silently
    await clearUserPendingCommand(userId);
    return;
  }

  if (COMPLETION_CONFIG.promptAfterCompletion.includes(completedAction)) {
    // Important action - prompt user
    await promptForMoreActions(
      handler,
      channelId,
      threadId,
      userId,
      completedAction,
      completedName,
    );
    return;
  }

  // Unknown action - default to clearing
  await clearUserPendingCommand(userId);
}
/**
 * Prompt user if they want to do more
 */
async function promptForMoreActions(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  completedAction: string,
  completedName?: string,
): Promise<void> {
  // Store prompt state
  const key = getPromptKey(userId, threadId);
  completionPrompts.set(key, {
    userId,
    threadId,
    channelId,
    completedAction,
    completedName,
    promptedAt: Date.now(),
  });

  // Set a special "waiting for continuation" state
  await setUserPendingCommand(
    userId,
    threadId,
    channelId,
    { action: "awaiting_continuation" as any },
    "continuation",
  );

  // send message asking if user wants anything else
  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `
   What's next? \n\n

  Would you like to do something else? Send "yes". \n\n

  Or would you like to finish here? Send "done" \n\n

    `,
  );

  // Set timeout to auto-clear after 5 minutes
  setTimeout(async () => {
    const currentPrompt = completionPrompts.get(key);
    if (
      currentPrompt &&
      currentPrompt.promptedAt === completionPrompts.get(key)?.promptedAt
    ) {
      // Prompt wasn't responded to - clear silently
      completionPrompts.delete(key);
      const userState = await getUserState(userId);
      if (userState?.pendingCommand?.waitingFor === "continuation") {
        await clearUserPendingCommand(userId);
      }
    }
  }, COMPLETION_CONFIG.promptTimeoutMs);
}

export async function handleCompletionResponse(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
    message: string;
  },
): Promise<void> {
  const { userId, channelId, eventId } = event;
  const threadId = event.threadId || eventId;

  const key = getPromptKey(userId, threadId);
  const promptState = completionPrompts.get(key);

  // Clean up prompt state
  completionPrompts.delete(key);

  if (event.message.split(" ").some((m) => m === "done")) {
    // User is done - clear everything
    await clearUserPendingCommand(userId);
    await clearActiveFlow(userId, threadId);

    await handler.sendMessage(
      channelId,
      `Great! Let me know if you need anything else. 👋`,
      { threadId },
    );
    return;
  }

  // User wants to do more - clear pending but keep context
  await clearUserPendingCommand(userId);

  // Suggest related actions based on what they just did
  const suggestions = getSuggestedActions(promptState?.completedAction);

  await handler.sendMessage(
    channelId,
    `What would you like to do next?\n\n${suggestions}`,
    { threadId },
  );
  return;
}

/**
 * Get suggested follow-up actions based on completed action
 */
function getSuggestedActions(completedAction?: string): string {
  const suggestions: Record<string, string> = {
    register:
      `You might want to:\n` +
      `• **Set records** - Add avatar, social links, addresses\n` +
      `• **Create subdomains** - e.g., mail.yourname.eth\n` +
      `• **Register another** - \`/register anothername.eth\``,

    renew:
      `You might want to:\n` +
      `• **Check expiry** - \`/expiry yourname.eth\`\n` +
      `• **View portfolio** - See all your names\n` +
      `• **Renew another** - \`/renew anothername.eth\``,

    transfer:
      `You might want to:\n` +
      `• **Verify transfer** - Check the recipient owns it now\n` +
      `• **Transfer another** - \`/transfer anothername.eth to 0x...\`\n` +
      `• **View portfolio** - See your remaining names`,

    subdomain:
      `You might want to:\n` +
      `• **Create another subdomain** - \`/subdomain team.yourname.eth\`\n` +
      `• **View portfolio** - See all your names\n` +
      `• **Set records** - Configure the subdomain`,
  };

  return (
    suggestions[completedAction || ""] ||
    `Just type what you'd like to do, or use a command like:\n` +
      `• \`/check name.eth\` - Check availability\n` +
      `• \`/register name.eth\` - Register a name\n` +
      `• \`/portfolio\` - View your names`
  );
}

/**
 * Check if user is in "waiting for continuation" state
 * and handle their message accordingly
 */
export async function handlePossibleContinuation(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  content: string,
): Promise<boolean> {
  const userState = await getUserState(userId);

  if (userState?.pendingCommand?.waitingFor !== "continuation") {
    return false; // Not in continuation state
  }

  const lowerContent = content.toLowerCase().trim();

  // Check for explicit "done" signals
  const doneSignals = [
    "done",
    "no",
    "nope",
    "i'm done",
    "im done",
    "that's all",
    "thats all",
    "nothing else",
    "all good",
    "thanks",
    "thank you",
  ];

  if (doneSignals.some((signal) => lowerContent.includes(signal))) {
    await clearUserPendingCommand(userId);
    await clearActiveFlow(userId, threadId);

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `No problem! Let me know if you need anything else. 👋`,
    );
    return true;
  }

  // Check for explicit "more" signals
  const moreSignals = ["yes", "yeah", "yep", "sure", "more", "another"];

  if (
    moreSignals.some(
      (signal) =>
        lowerContent === signal || lowerContent.startsWith(signal + " "),
    )
  ) {
    await clearUserPendingCommand(userId);

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `What would you like to do next?`,
    );
    return true;
  }

  // User is typing a new command - clear continuation state and process normally
  await clearUserPendingCommand(userId);
  return false; // Let normal processing handle it
}

/**
 * Clean up stale completion prompts (call periodically)
 */
export function cleanupStalePrompts(): void {
  const now = Date.now();

  for (const [key, state] of completionPrompts.entries()) {
    if (now - state.promptedAt > COMPLETION_CONFIG.promptTimeoutMs) {
      completionPrompts.delete(key);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupStalePrompts, 10 * 60 * 1000);
