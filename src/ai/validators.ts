import { isAddress, getAddress } from "viem";
import {
  VALID_ACTIONS_LIST,
  VALID_ACTIONS,
  ParsedCommand,
  BaseCommand,
  CommandOptions,
  RenewCommand,
  RegisterCommand,
  HelpCommand,
  EnsRecords,
  PendingCommand,
  ValidationResult,
  QuestionType,
  QUESTION_TYPES,
} from "../types";

export function validate_parse(
  parsed: unknown,
  context?: { recentMessages?: string[]; pendingCommand?: PendingCommand },
): ValidationResult {
  if (typeof parsed !== "object" || parsed === null) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "I didn't quite understand that. Could you rephrase your request?",
      partial: {},
    };
  }

  const fields = parsed as Record<string, unknown>;

  // action
  if (typeof fields.action !== "string") {
    return {
      valid: false,
      needsClarification: true,
      question:
        "What would you like to do? (check, register, renew, transfer, set records, or view portfolio)",
      partial: {},
    };
  }

  const action = fields.action as ParsedCommand["action"];
  const names = Array.isArray(fields.names) ? (fields.names as string[]) : [];

  switch (action) {
    case "check": {
      return validateCheckCommand(names);
    }
    case "register":
      return validateRegisterCommand(names, fields.duration, context);

    case "renew":
      return validateRenewCommand(names, fields.duration, context);

    case "transfer":
      return validateTransferCommand(names, fields.recipient);

    case "set":
      return validateSetCommand(names, fields.records);

    case "portfolio":
      return validatePortfolioCommand(fields.address, fields.options);

    case "expiry":
      return validateExpiryCommand(names);

    case "history":
      return validateHistoryCommand(names);

    case "remind":
      return validateRemindCommand(names);

    case "watch":
      return validateWatchCommand(names);

    case "subdomain":
      return validateSubdomainCommand(names);

    case "question":
      return validateQuestionCommand(fields.questionType, fields.questionText);

    case "help":
      return { valid: true, command: { action: "help", names: [] } };

    // TODO: Add other actions
    default:
      return {
        valid: false,
        needsClarification: true,
        question: `I don't support the action "${action}". Try: check, register, renew, transfer, set, portfolio, or help.`,
        partial: {},
      };
  }
}

// -- helpers --
function validateCheckCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which ENS name would you like me to check? (like alice.eth) 🔍",
      partial: { action: "check", names: [] },
    };
  }

  // Validate ENS format - must end with .eth
  const invalidNames = names.filter((n) => !n.toLowerCase().endsWith(".eth"));
  if (invalidNames.length > 0) {
    const suggestions = invalidNames.map((n) => `${n}.eth`).join(", ");
    return {
      valid: false,
      needsClarification: true,
      question: `ENS names need to end with .eth! Did you mean: ${suggestions}? 😊`,
      partial: { action: "check", names },
    };
  }

  return {
    valid: true,
    command: { action: "check", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateRegisterCommand(
  names: string[],
  duration: unknown,
  context?: { pendingCommand?: PendingCommand },
): ValidationResult {
  // Check names first
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which ENS name would you like to register? (like alice.eth) 📝",
      partial: { action: "register", names: [] },
    };
  }

  // Validate ENS format
  const invalidNames = names.filter((n) => !n.toLowerCase().endsWith(".eth"));
  if (invalidNames.length > 0) {
    const suggestions = invalidNames.map((n) => `${n}.eth`).join(", ");
    return {
      valid: false,
      needsClarification: true,
      question: `ENS names need to end with .eth! Did you mean: ${suggestions}? 😊`,
      partial: { action: "register", names },
    };
  }

  // Check duration
  if (duration === undefined || duration === null) {
    return {
      valid: false,
      needsClarification: true,
      question: `For how many years would you like to register ${names.join(", ")}? (1-10 years) ⏰`,
      partial: { action: "register", names },
    };
  }

  // Validate duration is a number
  const durationNum = Number(duration);
  if (isNaN(durationNum) || !Number.isInteger(durationNum)) {
    return {
      valid: false,
      needsClarification: true,
      question: "Please give me a number of years (like 1, 2, or 3) 🔢",
      partial: { action: "register", names },
    };
  }

  // Validate duration range
  if (durationNum < 1 || durationNum > 10) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "I can register names for 1 to 10 years. How many years would you like? 📅",
      partial: { action: "register", names, duration: durationNum },
    };
  }

  // All valid!
  const isBatch = names.length > 1;
  return {
    valid: true,
    command: {
      action: "register",
      names: names.map((n) => n.toLowerCase()),
      duration: durationNum,
      options: isBatch ? { batch: true } : undefined,
    },
  };
}

function validateRenewCommand(
  names: string[],
  duration: unknown,
  context?: { pendingCommand?: PendingCommand },
): ValidationResult {
  // Check names
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which names would you like to renew? (or say 'all my names') 🔄",
      partial: { action: "renew", names: [] },
    };
  }

  // Check duration
  if (duration === undefined || duration === null) {
    return {
      valid: false,
      needsClarification: true,
      question: `For how many years would you like to renew ${names.join(", ")}? (1-10 years) ⏰`,
      partial: { action: "renew", names },
    };
  }

  const durationNum = Number(duration);
  if (
    isNaN(durationNum) ||
    !Number.isInteger(durationNum) ||
    durationNum < 1 ||
    durationNum > 10
  ) {
    return {
      valid: false,
      needsClarification: true,
      question: "Please tell me how many years (1 to 10) 📅",
      partial: { action: "renew", names },
    };
  }

  const isBatch = names.length > 1;
  return {
    valid: true,
    command: {
      action: "renew",
      names: names.map((n) => n.toLowerCase()),
      duration: durationNum,
      options: isBatch ? { batch: true } : undefined,
    },
  };
}

function validateTransferCommand(
  names: string[],
  recipient: unknown,
): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like to transfer? 📤",
      partial: { action: "transfer", names: [] },
    };
  }

  if (!recipient || typeof recipient !== "string") {
    return {
      valid: false,
      needsClarification: true,
      question: `Where should I send ${names[0]}? Give me an Ethereum address (starts with 0x) 📬`,
      partial: { action: "transfer", names },
    };
  }

  if (!isAddress(recipient)) {
    return {
      valid: false,
      needsClarification: true,
      question: `"${recipient}" doesn't look like an Ethereum address. It should start with 0x and be 42 characters long! 🔍`,
      partial: { action: "transfer", names, recipient },
    };
  }

  return {
    valid: true,
    command: {
      action: "transfer",
      names: names.map((n) => n.toLowerCase()),
      recipient,
    },
  };
}

function validateSetCommand(
  names: string[],
  records: unknown,
): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like to set records for? ⚙️",
      partial: { action: "set", names: [] },
    };
  }

  if (!records || typeof records !== "object") {
    return {
      valid: false,
      needsClarification: true,
      question: `What would you like to set for ${names[0]}? You can set: address, twitter, github, email, url, avatar, or description 📋`,
      partial: { action: "set", names },
    };
  }

  const recordsObj = records as Record<string, unknown>;
  const validKeys: (keyof EnsRecords)[] = [
    "address",
    "twitter",
    "github",
    "email",
    "url",
    "avatar",
    "description",
  ];

  // Check if at least one valid key exists
  const hasValidKey = validKeys.some((key) => recordsObj[key] !== undefined);
  if (!hasValidKey) {
    return {
      valid: false,
      needsClarification: true,
      question: `I didn't find any records to set. You can set: ${validKeys.join(", ")} 📝`,
      partial: { action: "set", names, records: {} },
    };
  }

  // Build clean records object with only valid string values
  const cleanRecords: EnsRecords = {};
  for (const key of validKeys) {
    const value = recordsObj[key];
    if (value !== undefined) {
      if (typeof value !== "string") {
        return {
          valid: false,
          needsClarification: true,
          question: `The value for "${key}" should be text, not a ${typeof value} 📝`,
          partial: { action: "set", names, records: recordsObj },
        };
      }
      cleanRecords[key] = value;
    }
  }

  return {
    valid: true,
    command: {
      action: "set",
      names: names.map((n) => n.toLowerCase()),
      records: cleanRecords,
    },
  };
}

function validatePortfolioCommand(
  address: string,
  options: unknown,
): ValidationResult {
  const opts = typeof options === "object" && options !== null ? options : {};

  if (!isAddress(address)) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "The address provided is not a valid wallet address. Let's try again",
      partial: { action: "portfolio", address },
    };
  }

  return {
    valid: true,
    command: {
      action: "portfolio",
      address: address,
      // options: opts as { batch?: boolean; filter?: "expiring" | "all" },
    },
  };
}

function validateExpiryCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like to check the expiry for? ⏰",
      partial: { action: "expiry", names: [] },
    };
  }

  return {
    valid: true,
    command: { action: "expiry", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateHistoryCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like to see the history for? 📜",
      partial: { action: "history", names: [] },
    };
  }

  return {
    valid: true,
    command: { action: "history", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateRemindCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like me to remind you about? 🔔",
      partial: { action: "remind", names: [] },
    };
  }

  return {
    valid: true,
    command: { action: "remind", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateWatchCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which ENS name would you like me to watch for availability? 👀",
      partial: { action: "watch", names: [] },
    };
  }

  return {
    valid: true,
    command: { action: "watch", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateSubdomainCommand(names: string[]): ValidationResult {
  if (!names.length) {
    return {
      valid: false,
      needsClarification: true,
      question: "Which ENS name would you like to create a subdomain for? 🏷️",
      partial: { action: "subdomain", names: [] },
    };
  }

  return {
    valid: true,
    command: { action: "subdomain", names: names.map((n) => n.toLowerCase()) },
  };
}

function validateQuestionCommand(
  questionType: unknown,
  questionText: unknown,
): ValidationResult {
  // Default to "general" if no type specified
  const type =
    typeof questionType === "string" &&
    QUESTION_TYPES.includes(questionType as QuestionType)
      ? (questionType as QuestionType)
      : "general";

  // Use the original question text, or a default
  const text =
    typeof questionText === "string" && questionText.trim()
      ? questionText.trim()
      : "General question about ENS";

  return {
    valid: true,
    command: {
      action: "question",
      questionType: type,
      questionText: text,
    },
  };
}
