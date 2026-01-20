import { isAddress } from "viem";
import { parseSubname } from "../services/ens/subdomain/subdomain.utils";
import {
	type EnsRecords,
	type ParsedCommand,
	QUESTION_TYPES,
	type QuestionType,
	type ValidationResult,
} from "../types";

export function validate_parse(parsed: unknown): ValidationResult {
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

	// Extract name - handle both string and array formats from parser
	let name: string | undefined;
	if (typeof fields.name === "string") {
		name = fields.name;
	} else if (Array.isArray(fields.names) && fields.names.length > 0) {
		name = fields.names[0] as string;
	} else if (Array.isArray(fields.name) && fields.name.length > 0) {
		name = fields.name[0] as string;
	}

	const address =
		typeof fields.address === "string" ? fields.address : undefined;

	switch (action) {
		case "check":
			return validateCheckCommand(name);

		case "register":
			return validateRegisterCommand(name, fields.duration);

		case "renew":
			return validateRenewCommand(name, fields.duration);

		case "transfer":
			return validateTransferCommand(name, fields.recipient);

		case "set":
			return validateSetCommand(name, fields.records);

		case "portfolio":
			return validatePortfolioCommand(address, name, fields.recipient);

		case "expiry":
			return validateExpiryCommand(name);

		case "history":
			return validateHistoryCommand(name);

		case "remind":
			return validateRemindCommand(name);

		case "watch":
			return validateWatchCommand(name);

		case "subdomain":
			return validateSubdomainCommand(name, fields.subdomain);

		case "question":
			return validateQuestionCommand(fields.questionType, fields.questionText);

		case "help":
			return { valid: true, command: { action: "help", name: "" } };

		default:
			return {
				valid: false,
				needsClarification: true,
				question: `I don't support the action "${action}". Try: check, register, renew, transfer, set, portfolio, or help.`,
				partial: {},
			};
	}
}

// ============================================
// Helper Validators (Single Name)
// ============================================

function validateCheckCommand(name: string | undefined): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question:
				"Which ENS name would you like me to check? (like alice.eth) 🔍",
			partial: { action: "check", name: "" },
		};
	}

	// Validate ENS format - must end with .eth
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "check", name },
		};
	}

	return {
		valid: true,
		command: { action: "check", name: name.toLowerCase() },
	};
}

function validateRegisterCommand(
	name: string | undefined,
	duration: unknown,
): ValidationResult {
	// Check name first
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question:
				"Which ENS name would you like to register? (like alice.eth) 📝",
			partial: { action: "register", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "register", name },
		};
	}

	// Check duration
	if (duration === undefined || duration === null) {
		return {
			valid: false,
			needsClarification: true,
			question: `For how many years would you like to register **${name}**? (1-10 years) ⏰`,
			partial: { action: "register", name },
		};
	}

	// Validate duration is a number
	const durationNum = Number(duration);
	if (Number.isNaN(durationNum) || !Number.isInteger(durationNum)) {
		return {
			valid: false,
			needsClarification: true,
			question: "Please give me a number of years (like 1, 2, or 3) 🔢",
			partial: { action: "register", name },
		};
	}

	// Validate duration range
	if (durationNum < 1 || durationNum > 10) {
		return {
			valid: false,
			needsClarification: true,
			question:
				"I can register names for 1 to 10 years. How many years would you like? 📅",
			partial: { action: "register", name, duration: durationNum },
		};
	}

	// All valid!
	return {
		valid: true,
		command: {
			action: "register",
			name: name.toLowerCase(),
			duration: durationNum,
		},
	};
}

function validateRenewCommand(
	name: string | undefined,
	duration: unknown,
): ValidationResult {
	// Check name
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which name would you like to renew? 🔄",
			partial: { action: "renew", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "renew", name },
		};
	}

	// Check duration
	if (duration === undefined || duration === null) {
		return {
			valid: false,
			needsClarification: true,
			question: `For how many years would you like to renew **${name}**? (1-10 years) ⏰`,
			partial: { action: "renew", name },
		};
	}

	const durationNum = Number(duration);
	if (
		Number.isNaN(durationNum) ||
		!Number.isInteger(durationNum) ||
		durationNum < 1 ||
		durationNum > 10
	) {
		return {
			valid: false,
			needsClarification: true,
			question: "Please tell me how many years (1 to 10) 📅",
			partial: { action: "renew", name },
		};
	}

	return {
		valid: true,
		command: {
			action: "renew",
			name: name.toLowerCase(),
			duration: durationNum,
		},
	};
}

function validateTransferCommand(
	name: string | undefined,
	recipient: unknown,
): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which ENS name would you like to transfer? 📤",
			partial: { action: "transfer", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "transfer", name },
		};
	}

	if (!recipient || typeof recipient !== "string") {
		return {
			valid: false,
			needsClarification: true,
			question: `Where should I send **${name}**? Give me an Ethereum address (starts with 0x) 📬`,
			partial: { action: "transfer", name },
		};
	}

	if (!isAddress(recipient)) {
		return {
			valid: false,
			needsClarification: true,
			question: `"${recipient}" doesn't look like an Ethereum address. It should start with 0x and be 42 characters long! 🔍`,
			partial: { action: "transfer", name, recipient },
		};
	}

	return {
		valid: true,
		command: {
			action: "transfer",
			name: name.toLowerCase(),
			recipient,
		},
	};
}

function validateSetCommand(
	name: string | undefined,
	records: unknown,
): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which ENS name would you like to set records for? ⚙️",
			partial: { action: "set", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "set", name },
		};
	}

	if (!records || typeof records !== "object") {
		return {
			valid: false,
			needsClarification: true,
			question: `What would you like to set for **${name}**? You can set: address, twitter, github, email, url, avatar, or description 📋`,
			partial: { action: "set", name },
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
			partial: { action: "set", name, records: {} },
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
					partial: { action: "set", name, records: recordsObj },
				};
			}
			cleanRecords[key] = value;
		}
	}

	return {
		valid: true,
		command: {
			action: "set",
			name: name.toLowerCase(),
			records: cleanRecords,
		},
	};
}

function validatePortfolioCommand(
	address: unknown,
	name?: string,
	recipient?: unknown,
): ValidationResult {
	// Try to find address from multiple possible fields
	let resolvedAddress: string | undefined;

	// Check address field first
	if (typeof address === "string" && isAddress(address)) {
		resolvedAddress = address;
	}
	// Check recipient field (parser sometimes puts it here)
	else if (typeof recipient === "string" && isAddress(recipient as string)) {
		resolvedAddress = recipient as string;
	}
	// Check name field (parser sometimes puts it here)
	else if (name && isAddress(name)) {
		resolvedAddress = name;
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
		},
	};
}

function validateExpiryCommand(name: string | undefined): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which ENS name would you like to check the expiry for? ⏰",
			partial: { action: "expiry", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "expiry", name },
		};
	}

	return {
		valid: true,
		command: { action: "expiry", name: name.toLowerCase() },
	};
}

function validateHistoryCommand(name: string | undefined): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which ENS name would you like to see the history for? 📜",
			partial: { action: "history", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "history", name },
		};
	}

	return {
		valid: true,
		command: { action: "history", name: name.toLowerCase() },
	};
}

function validateRemindCommand(name: string | undefined): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question: "Which ENS name would you like me to remind you about? 🔔",
			partial: { action: "remind", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "remind", name },
		};
	}

	return {
		valid: true,
		command: { action: "remind", name: name.toLowerCase() },
	};
}

function validateWatchCommand(name: string | undefined): ValidationResult {
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question:
				"Which ENS name would you like me to watch for availability? 👀",
			partial: { action: "watch", name: "" },
		};
	}

	// Validate ENS format
	if (!name.toLowerCase().endsWith(".eth")) {
		const suggestion = `${name}.eth`;
		return {
			valid: false,
			needsClarification: true,
			question: `ENS names need to end with .eth! Did you mean: ${suggestion}? 😊`,
			partial: { action: "watch", name },
		};
	}

	return {
		valid: true,
		command: { action: "watch", name: name.toLowerCase() },
	};
}

function validateSubdomainCommand(
	name: string | undefined,
	subdomain: unknown,
): ValidationResult {
	// Must have a name
	if (!name) {
		return {
			valid: false,
			needsClarification: true,
			question:
				"Which subdomain would you like to create? For example: blog.yourname.eth",
			partial: { action: "subdomain", name: "" },
		};
	}

	// If no subdomain object provided, try to parse from name
	if (!subdomain || typeof subdomain !== "object") {
		const parsed = parseSubname(name);
		if (!parsed) {
			return {
				valid: false,
				needsClarification: true,
				question:
					"I couldn't parse the subdomain. Please specify like: blog.yourname.eth",
				partial: { action: "subdomain", name },
			};
		}

		// Parsed name but no subdomain object - need address
		return {
			valid: false,
			needsClarification: true,
			question: `What address should **${name}** point to? Please provide an Ethereum address (0x...) or ENS name.`,
			partial: {
				action: "subdomain",
				name,
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
		const parsed = parseSubname(name);
		if (!parsed) {
			return {
				valid: false,
				needsClarification: true,
				question:
					"I couldn't determine the parent domain. Please specify like: blog.yourname.eth",
				partial: {
					action: "subdomain",
					name,
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
			question: `What address should **${sub.label}.${sub.parent}** point to? Please provide an Ethereum address (0x...) or ENS name.`,
			partial: {
				action: "subdomain",
				name,
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
				name,
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
			name: name.toLowerCase(),
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
