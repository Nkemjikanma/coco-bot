import type { BotHandler } from "@towns-protocol/bot";
import { appendMessageToSession } from "../db";
import type { ParsedCommand, PendingCommand, SubdomainCommand } from "../types";

// tries to determine what we are waiting for
export function determineWaitingFor(
  partial: Partial<ParsedCommand>,
): PendingCommand["waitingFor"] {
  // Check if we need names
  const needsNames = [
    "check",
    "register",
    "renew",
    "transfer",
    "set",
    "expiry",
    "history",
    "remind",
    "watch",
    "subdomain",
  ].includes(partial.action || "");

  if (needsNames && (!("name" in partial) || !partial.name)) {
    return "name";
  }

  // Check if we need duration
  if (partial.action === "register" || partial.action === "renew") {
    if (!("duration" in partial) || partial.duration === undefined) {
      return "duration";
    }
  }

  // Check if we need recipient
  if (partial.action === "transfer" && !("recipient" in partial)) {
    return "recipient";
  }

  // Check if we need records
  if (partial.action === "set" && !("records" in partial)) {
    return "records";
  }

  if (partial.action === "subdomain") {
    const subCmd = partial as Partial<SubdomainCommand>;
    if (!subCmd.subdomain?.resolveAddress) {
      return "subdomain_address";
    }
  }

  return "confirmation";
}

export function formatRustPayload(command: ParsedCommand) {
  const lines: string[] = ["**Ready to execute; **", ""];

  // Action
  lines.push(`**Action:** ${command.action}`);

  // Names (if applicable)
  if ("names" in command && command.names) {
    lines.push(`**Names:** ${command.names}`);
  }

  // Duration (for register/renew)
  if ("duration" in command && command.duration !== undefined) {
    const yearWord = command.duration === 1 ? "year" : "years";
    lines.push(`**Duration:** ${command.duration} ${yearWord}`);
  }

  // Recipient (for transfer)
  if ("recipient" in command && command.recipient) {
    lines.push(`**Recipient:** ${command.recipient}`);
  }

  if ("records" in command && command.records) {
    const recordEntries = Object.entries(command.records)
      .filter(([_, value]) => value !== undefined)
      .map(([key, value]) => `  • ${key}: ${value}`)
      .join("\n");

    if (recordEntries) {
      lines.push(`**Records:**\n${recordEntries}`);
    }
  }

  // Options (if applicable)
  if ("options" in command && command.options) {
    if (command.options.batch) {
      lines.push(`**Batch:** Yes`);
    }
    if (command.options.filter) {
      lines.push(`**Filter:** ${command.options.filter}`);
    }
  }

  // TODO: revisit because too much formating
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(command, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("_[This payload will be sent to Rust backend]_");

  return lines.join("\n");
}

export async function extractMissingInfo(
  partial: Partial<ParsedCommand>,
  userResponse: string,
  waitingFor: PendingCommand["waitingFor"],
): Promise<Partial<ParsedCommand>> {
  const updated = { ...partial };

  switch (waitingFor) {
    case "duration": {
      const match = userResponse.match(/(\d+)\s*(?:year|yr)?s?/i);
      if (
        match &&
        (updated.action === "register" || updated.action === "renew")
      ) {
        updated.duration = parseInt(match[1]);
      }
      break;
    }

    case "name": {
      const name = userResponse.match(/[\w-]+\.eth/gi);
      if (
        name &&
        (updated.action === "check" ||
          updated.action === "register" ||
          updated.action === "renew" ||
          updated.action === "transfer" ||
          updated.action === "set" ||
          updated.action === "expiry" ||
          updated.action === "history" ||
          updated.action === "remind" ||
          updated.action === "watch" ||
          updated.action === "subdomain") // ✅ ADD subdomain here
      ) {
        updated.name = name.toString();
      }
      break;
    }

    case "recipient": {
      const addressMatch = userResponse.match(/0x[a-fA-F0-9]{40}/);
      if (addressMatch && updated.action === "transfer") {
        updated.recipient = addressMatch[0];
      }
      break;
    }

    // ✅ ADD THIS CASE:
    case "subdomain_address":
      if (updated.action === "subdomain") {
        // Extract address or ENS name
        const addrMatch = userResponse.match(/0x[a-fA-F0-9]{40}/);
        const ensMatch = userResponse.match(/[\w-]+\.eth/gi);

        const subdomainCmd = updated as Partial<SubdomainCommand>;

        if (addrMatch) {
          subdomainCmd.subdomain = {
            ...subdomainCmd.subdomain,
            resolveAddress: addrMatch[0] as `0x${string}`,
            owner: addrMatch[0] as `0x${string}`,
          };
        } else if (ensMatch && ensMatch.length > 0) {
          // User provided an ENS name - will be resolved later
          subdomainCmd.subdomain = {
            ...subdomainCmd.subdomain,
            resolveAddress: ensMatch[0] as `0x${string}`,
            owner: ensMatch[0] as `0x${string}`,
          };
        }
      }
      break;

    case "confirmation":
    case "wallet_selection":
    case "bridge_confirmation":
      break;
  }

  return updated;
}

/**
 * Returns the help message showing all available commands
 */
export function getHelpMessage(): string {
  return `👋 **Hi! I'm Coco, your ENS assistant.**

**Talk to me naturally:**\n\n
_"Check if alice.eth is available"_ \n\n
_"Register bob.eth for 2 years"_ \n\n
_"How much does a 3-letter name cost?"_\n\n

**Or use commands:**
🔍 \`/check alice.eth\` - Check availability \n\n
📝 \`/register alice.eth 3\` - Register for 3 years \n\n
🔄 \`/renew alice.eth 2\` - Renew for 2 years - coming soon \n\n
📤 \`/transfer alice.eth 0x...\` - Transfer to address\n\n
⚙️ \`/set alice.eth\` - Set records - coming soon \n\n
📂 \`/portfolio\` - View your names \n\n
⏰ \`/expiry alice.eth\` - Check expiration \n\n
📜 \`/history alice.eth\` - Registration history \n\n
🔔 \`/remind alice.eth\` - Set reminder - coming soon \n\n
👀 \`/watch alice.eth\` - Watch availability - coming soon\n\n

**Ask me anything about ENS!** 💡`;
}

/**
 * Returns the appropriate question for what we're waiting for
 */
export function getWaitingForMessage(pending: PendingCommand): string {
  const { partialCommand, waitingFor } = pending;
  const action = partialCommand.action || "something";
  const names =
    "name" in partialCommand && partialCommand.name
      ? partialCommand.name
      : "your name(s)";

  switch (waitingFor) {
    case "duration":
      return `Let's continue ${action}ing **${names}**. How many years would you like to register for? (1-10)`;

    case "name":
      return `Let's continue. Which ENS name(s) would you like to ${action}?`;

    case "recipient":
      return `Let's continue transferring **${names}**. What's the recipient's address?`;

    case "records":
      return `Let's continue setting records for **${names}**. What records would you like to set?`;

    case "confirmation":
      return `Let's continue with registering **${names}**. I'll send you the confirmation to approve.`;

    default:
      return "Let's continue where you left off.";
  }
}

// send message and store in session
export async function sendBotMessage(
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
