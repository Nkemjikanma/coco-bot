import { BotHandler, BasePayload } from "@towns-protocol/bot";
import { ChannelMessage_Post_Mention } from "@towns-protocol/proto";

export interface Message {
  eventId: string;
  userId: string;
  content: string;
  timestamp: number;
  role: "user" | "assistant";
}

export interface Session {
  threadId: string;
  userId: string;
  lastMessageAt: number;
  messages: Message[];
}

export const VALID_ACTIONS_LIST = [
  "check",
  "register",
  "renew",
  "transfer",
  "set",
  "portfolio",
  "subdomain",
  "expiry",
  "history",
  "remind",
  "watch",
  "help",
] as const;

export type VALID_ACTIONS = (typeof VALID_ACTIONS_LIST)[number];

export interface EnsRecords {
  address?: string;
  twitter?: string;
  github?: string;
  email?: string;
  url?: string;
  avatar?: string;
  description?: string;
}

export type BaseCommand = {
  needsClarification?: boolean;
  clarificationQuestion?: string;
};

export type CommandOptions = {
  batch?: boolean;
  // used for portfolio/renew
  filter?: "expiring" | "all";
};

/**
 * action: "check"
 */
export interface CheckCommand extends BaseCommand {
  action: "check";
  names: string[];
}

/**
 * action: "register"
 * Years (1-10)
 */
export interface RegisterCommand extends BaseCommand {
  action: "register";
  names: string[];
  duration: number; // 1–10
  options: CommandOptions;
}

/**
 * action: "renew"
 * Years (1-10)
 */
export interface RenewCommand extends BaseCommand {
  action: "renew";
  names: string[];
  duration: number; // 1–10
  options: CommandOptions;
}

/**
 * action: "transfer"
 * Ethereum address recipient
 */
export interface TransferCommand extends BaseCommand {
  action: "transfer";
  names: string[];
  recipient: string; // Ethereum address
}

/**
 * action: "set"
 * Set various records for the name(s)
 */
export interface SetCommand extends BaseCommand {
  action: "set";
  names: string[];
  records: EnsRecords;
}

/**
 * action: "portfolio"
 */
export interface PortfolioCommand extends BaseCommand {
  action: "portfolio";
  names: string[];
  options?: CommandOptions;
}

// TODO: Figure out implementation
export interface SubdomainCommand extends BaseCommand {
  action: "subdomain";
}

export interface ExpiryCommand extends BaseCommand {
  action: "expiry";
  names: string[];
}

export interface HistoryCommand extends BaseCommand {
  action: "history";
  names: string[];
}

export interface RemindCommand extends BaseCommand {
  action: "remind";
  names: string[];
}

export interface WatchCommand extends BaseCommand {
  action: "watch";
  names: string[];
}

export interface HelpCommand extends BaseCommand {
  action: "help";
  names?: string[];
}
export type ParsedCommand =
  | CheckCommand
  | RegisterCommand
  | RenewCommand
  | TransferCommand
  | SetCommand
  | PortfolioCommand
  | SubdomainCommand
  | ExpiryCommand
  | HistoryCommand
  | RemindCommand
  | WatchCommand
  | HelpCommand;

export type EventType = BasePayload & {
  command:
    | "help"
    | "check"
    | "register"
    | "renew"
    | "transfer"
    | "set"
    | "subdomain"
    | "portfolio"
    | "expiry"
    | "history"
    | "remind"
    | "watch"
    | "migrate";
  args: string[];
  mentions: Pick<ChannelMessage_Post_Mention, "userId" | "displayName">[];
  replyId: string | undefined;
  threadId: string | undefined;
};
