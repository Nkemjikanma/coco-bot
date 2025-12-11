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
} from "../types";

class InvalidStructureError extends Error {}
class InvalidActionError extends Error {}
class InvalidNameError extends Error {}
class InvalidDurationError extends Error {}
class InvalidRecipientError extends Error {}
class InvalidRecordsError extends Error {}

export function validate_parse(fields: unknown): ParsedCommand {
  if (typeof fields !== "object" || fields === null) {
    throw new InvalidStructureError("Fields must be an object");
  }

  const parsed_fields = fields as Record<string, unknown>;

  // action
  if (typeof parsed_fields.action !== "string") {
    throw new InvalidActionError("Missing or invalid 'action' field");
  }

  const action = parsed_fields.action as ParsedCommand["action"];

  if (!VALID_ACTIONS_LIST.includes(action as VALID_ACTIONS)) {
    throw new InvalidActionError(`Unsupported action ${action}`);
  }

  const names_raw = parsed_fields.names;
  if (action) {
    if (
      !Array.isArray(names_raw) ||
      !names_raw.every((n) => typeof n === "string")
    ) {
      throw new InvalidStructureError("'names' must be an array of strings");
    }

    for (const name of names_raw as string[]) {
      if (!name.toLowerCase().endsWith(".eth")) {
        throw new InvalidNameError(`Invalid ENS name: ${name}`);
      }
    }
  }

  const names = (names_raw ?? []) as string[];

  // get the base command names, needs clarification, clarification question, options - batch and filer
  const base = {
    needsClarification:
      typeof parsed_fields.needsClarification === "boolean"
        ? parsed_fields.needsClarification
        : undefined,

    clarificationQuestion:
      typeof parsed_fields.clarificationQuestion === "string"
        ? parsed_fields.clarificationQuestion
        : undefined,
  };

  switch (action) {
    case "check": {
      if (!names.length) {
        throw new InvalidStructureError(
          "'names' must not be empty for 'check'",
        );
      }

      const options = validate_options(parsed_fields.options);

      return {
        action,
        names,
        ...base,
        ...(options ? { options } : {}),
      };
    }

    case "register":
    case "renew": {
      if (!names.length) {
        throw new InvalidStructureError(
          `'names' must not be empty for '${action}'`,
        );
      }

      const durationRaw = parsed_fields.duration;

      if (typeof durationRaw !== "number" || !Number.isInteger(durationRaw)) {
        throw new InvalidDurationError("'duration' must be an integer (years)");
      }
      if (durationRaw < 1 || durationRaw > 10) {
        throw new InvalidDurationError(
          "'duration' must be between 1 and 10 years",
        );
      }

      const options = validate_options(parsed_fields.options);
      const cmd = {
        action,
        names,
        duration: durationRaw,
        ...base,
        ...(options ? { options } : {}),
      };
      if (action === "register") return cmd as RegisterCommand;
      return cmd as RenewCommand;
    }

    case "transfer": {
      if (!names.length) {
        throw new InvalidStructureError(
          "'names' must not be empty for 'transfer'",
        );
      }

      const recipient = parsed_fields.recipient;
      if (typeof recipient !== "string") {
        throw new InvalidRecipientError(
          "Missing or invalid 'recipient' for 'transfer'",
        );
      }

      if (!isAddress(recipient)) {
        throw new InvalidRecipientError(
          `Invalid Ethereum address: ${recipient}`,
        );
      }

      return {
        action,
        names,
        recipient,
        ...base,
      };
    }

    case "set": {
      if (!names.length) {
        throw new InvalidStructureError("'names' must not be empty for 'set'");
      }

      const records = validate_records(parsed_fields.records);
      return {
        action,
        names,
        records,
        ...base,
      };
    }

    case "portfolio": {
      // You might allow empty names for "portfolio", but your schema suggests they’re needed.
      if (!names.length) {
        throw new InvalidStructureError(
          "'names' must not be empty for 'portfolio'",
        );
      }

      const options = validate_options(parsed_fields.options);
      return {
        action,
        names,
        ...base,
        ...(options ? { options } : {}),
      };
    }

    case "help": {
      const command: HelpCommand = {
        action: "help",
        names: names ? names : [],
        ...base,
      };
      return command;
    }

    // TODO: Add other actions
    default:
      throw new InvalidActionError(
        `Action not supported by validator: ${action}`,
      );
  }
}

// -- helpers --

function validate_options(raw: unknown): CommandOptions | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidStructureError("options' must be an object");
  }

  const options_obj = raw as Record<string, unknown>;
  const options: CommandOptions = {};

  if (options_obj.batch !== undefined) {
    if (typeof options_obj.batch !== "boolean") {
      throw new InvalidStructureError("'options.batch' must be a boolean");
    }
    options.batch = options_obj.batch;
  }

  if (options_obj.filter !== undefined) {
    if (options_obj.filter !== "expiring" && options_obj.filter !== "all") {
      throw new InvalidStructureError(
        "'options.filter' must be 'expiring' or 'all'",
      );
    }
    options.filter = options_obj.filter;
  }

  return options;
}

function validate_records(raw: unknown): EnsRecords {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidStructureError("options' must be an object");
  }

  const records_obj = raw as Record<string, unknown>;
  let records: EnsRecords = {};
  const keys: (keyof EnsRecords)[] = [
    "address",
    "twitter",
    "github",
    "email",
    "url",
    "avatar",
    "description",
  ];

  for (const key of keys) {
    const value = records_obj[key];

    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new InvalidRecordsError(`'records.${key}' must be a string`);
      }
      records[key] = value;
    }
  }

  if (Object.keys(records).length === 0) {
    throw new InvalidRecordsError(
      "'records' must contain at least one field for 'set'",
    );
  }

  return records;
}
