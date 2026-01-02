import { isAddress } from "viem";
import {
  type EnsRecords,
  type ParsedCommand,
  type PendingCommand,
  QUESTION_TYPES,
  type QuestionType,
  type ValidationResult,
} from "../types";
import { parseSubname } from "../services/ens/subdomain/subdomain.utils";

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
  const address =
    typeof fields.address === "string" ? (fields.address as string) : "";

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
      return validatePortfolioCommand(
        address,
        fields.options,
        names,
        fields.recipient,
      );

    case "expiry":
      return validateExpiryCommand(names);

    case "history":
      return validateHistoryCommand(names);

    case "remind":
      return validateRemindCommand(names);

    case "watch":
      return validateWatchCommand(names);

    case "subdomain":
      return validateSubdomainCommand(names, fields.subdomain);

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
  address: unknown,
  options: unknown,
  names?: string[],
  recipient?: unknown,
): ValidationResult {
  const opts = typeof options === "object" && options !== null ? options : {};

  // Try to find address from multiple possible fields
  let resolvedAddress: string | undefined;

  // Check address field first
  if (typeof address === "string" && isAddress(address)) {
    resolvedAddress = address;
  }
  // Check recipient field (parser sometimes puts it here)
  else if (typeof recipient === "string" && isAddress(recipient)) {
    resolvedAddress = recipient;
  }
  // Check names array (parser sometimes puts it here)
  else if (names && names.length > 0 && isAddress(names[0])) {
    resolvedAddress = names[0];
  }

  console.log("Validate portfolio command", resolvedAddress);

  if (!resolvedAddress) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which wallet address would you like to see the portfolio for? Please provide an Ethereum address (0x...)",
      partial: { action: "portfolio" },
    };
  }

  return {
    valid: true,
    command: {
      action: "portfolio",
      address: resolvedAddress as `0x${string}`,

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

function validateSubdomainCommand(
  names: string[],
  subdomain: unknown,
): ValidationResult {
  // Must have at least one subname
  if (!names || names.length === 0) {
    return {
      valid: false,
      needsClarification: true,
      question:
        "Which subdomain would you like to create? For example: blog.yourname.eth",
      partial: { action: "subdomain", names: [] },
    };
  }

  // If no subdomain object provided, try to parse from names
  if (!subdomain || typeof subdomain !== "object") {
    const parsed = parseSubname(names[0]);
    if (!parsed) {
      return {
        valid: false,
        needsClarification: true,
        question:
          "I couldn't parse the subdomain. Please specify like: blog.yourname.eth",
        partial: { action: "subdomain", names },
      };
    }

    // Parsed name but no subdomain object - need address
    return {
      valid: false,
      needsClarification: true,
      question: `What address should ${names[0]} point to? Please provide an Ethereum address (0x...) or ENS name.`,
      partial: {
        action: "subdomain",
        names,
        subdomain: { parent: parsed.parent, label: parsed.label },
      },
    };
  }

  // Type the subdomain object
  const sub = subdomain as {
    parent?: string;
    label?: string;
    resolveAddress?: string;
    owner?: string;
  };

  // Validate parent and label exist
  if (!sub.parent || !sub.label) {
    const parsed = parseSubname(names[0]);
    if (!parsed) {
      return {
        valid: false,
        needsClarification: true,
        question:
          "I couldn't determine the parent domain. Please specify like: blog.yourname.eth",
        partial: {
          action: "subdomain",
          names,
          subdomain: {
            parent: sub.parent,
            label: sub.label,
            resolveAddress: sub.resolveAddress as `0x${string}`,
          },
        },
      };
    }
    // Use parsed values
    sub.parent = parsed.parent;
    sub.label = parsed.label;
  }

  if (!sub.resolveAddress) {
    return {
      valid: false,
      needsClarification: true,
      question: `What address should ${sub.label}.${sub.parent} point to? Please provide an Ethereum address (0x...) or ENS name.`,
      partial: {
        action: "subdomain",
        names,
        subdomain: { parent: sub.parent, label: sub.label },
      },
    };
  }

  // Validate the address format
  // Note: We allow ENS names here too (ending in .eth), they'll be resolved later
  const isENSName = sub.resolveAddress.toLowerCase().endsWith(".eth");
  if (!isENSName && !isAddress(sub.resolveAddress)) {
    return {
      valid: false,
      needsClarification: true,
      question: `"${sub.resolveAddress}" doesn't look like a valid Ethereum address or ENS name. Please provide a valid address (0x...) or ENS name (.eth).`,
      partial: {
        action: "subdomain",
        names,
        subdomain: { parent: sub.parent, label: sub.label },
      },
    };
  }

  // For valid addresses, cast to the right type
  // For ENS names, we'll resolve them later in the handler
  const resolveAddress = sub.resolveAddress as `0x${string}`;
  const owner = (sub.owner || sub.resolveAddress) as `0x${string}`;

  // All valid!
  return {
    valid: true,
    command: {
      action: "subdomain",
      names: names.map((n) => n.toLowerCase()),
      subdomain: {
        parent: sub.parent,
        label: sub.label,
        resolveAddress,
        owner,
      },
    },
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
