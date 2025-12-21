import type { ParsedCommand, PendingCommand } from "../types";

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
  ].includes(partial.action || "");

  if (
    needsNames &&
    (!("names" in partial) || !partial.names || partial.names.length === 0)
  ) {
    return "names";
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

  return "confirmation";
}

export function formatRustPayload(command: ParsedCommand) {
  const lines: string[] = ["**Ready to execute; **", ""];

  // Action
  lines.push(`**Action:** ${command.action}`);

  // Names (if applicable)
  if ("names" in command && command.names && command.names.length > 0) {
    lines.push(`**Names:** ${command.names.join(", ")}`);
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
      .filter(([_, value]) => value != undefined)
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

export function extractMissingInfo(
  partial: Partial<ParsedCommand>,
  userResponse: string,
  waitingFor: PendingCommand["waitingFor"],
): Partial<ParsedCommand> {
  const updated = { ...partial };

  switch (waitingFor) {
    case "duration": {
      // Extract number from response (e.g., "3 years", "3", "three years")
      const match = userResponse.match(/(\d+)\s*(?:year|yr)?s?/i);
      if (
        match &&
        (updated.action === "register" || updated.action === "renew")
      ) {
        (updated as any).duration = parseInt(match[1], 10);
      }
      break;
    }

    case "names": {
      // First, try to extract names that already have .eth
      const namesWithEth = userResponse.match(/[\w-]+\.eth/gi) || [];

      if (namesWithEth.length > 0) {
        (updated as any).names = namesWithEth;
      } else {
        // User typed something without .eth - extract words and add .eth
        // This handles responses like "alice" or "alice bob charlie"
        const words = userResponse
          .toLowerCase()
          .split(/[\s,]+/) // Split on spaces or commas
          .map((w) => w.trim())
          .filter((word) => /^[\w-]+$/.test(word) && word.length >= 3);

        if (words.length > 0) {
          // Add .eth to each word - validator will confirm with user
          (updated as any).names = words.map((w) => `${w}.eth`);
        }
      }
      break;
    }

    case "recipient": {
      // Extract Ethereum address
      const addressMatch = userResponse.match(/0x[a-fA-F0-9]{40}/);
      if (addressMatch && updated.action === "transfer") {
        (updated as any).recipient = addressMatch[0];
      }
      break;
    }

    case "records": {
      // This is complex - for now, re-parse with LLM would be better
      // Just pass through for now
      break;
    }

    case "confirmation": {
      // User confirmed - return as-is
      break;
    }
  }

  return updated;
}

/**
 * Returns the help message showing all available commands
 */
export function getHelpMessage(): string {
  return `👋 **Hi! I'm Coco, your ENS assistant.**

**Talk to me naturally:**
_"Check if alice.eth is available"_
_"Register bob.eth for 2 years"_
_"How much does a 3-letter name cost?"_

**Or use commands:**
🔍 \`/check alice.eth\` - Check availability
📝 \`/register alice.eth 3\` - Register for 3 years
🔄 \`/renew alice.eth 2\` - Renew for 2 years
📤 \`/transfer alice.eth 0x...\` - Transfer to address
⚙️ \`/set alice.eth\` - Set records
📂 \`/portfolio\` - View your names
⏰ \`/expiry alice.eth\` - Check expiration
📜 \`/history alice.eth\` - Registration history
🔔 \`/remind alice.eth\` - Set reminder
👀 \`/watch alice.eth\` - Watch availability

**Ask me anything about ENS!** 💡`;
}

/**
 * Returns the appropriate question for what we're waiting for
 */
export function getWaitingForMessage(pending: PendingCommand): string {
  const { partialCommand, waitingFor } = pending;

  switch (waitingFor) {
    case "names":
      return `Which ENS name would you like to ${partialCommand.action || "work with"}?`;
    case "duration": {
      const names =
        "names" in partialCommand && partialCommand.names?.length
          ? partialCommand.names.join(", ")
          : "the name";
      return `For how many years would you like to ${partialCommand.action} ${names}? (1-10 years)`;
    }
    case "recipient":
      return "What's the recipient address? (starts with 0x)";
    case "records":
      return "What records would you like to set?";
    case "confirmation":
      return "Ready when you are! Say 'confirm' to proceed or 'cancel' to stop.";
    default:
      return "What would you like to do next?";
  }
}
