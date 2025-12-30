import type { BasePayload, Bot } from "@towns-protocol/bot";
import type { ChannelMessage_Post_Mention } from "@towns-protocol/proto";
import type { Address } from "./api/types";
import commands from "./commands";

export type CocoBotType = Bot<typeof commands>;
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

export interface PendingCommand {
  partialCommand: Partial<ParsedCommand>;
  waitingFor:
    | "duration"
    | "names"
    | "recipient"
    | "records"
    | "confirmation"
    | "wallet_selection"
    | "bridge_confirmation"
    | "subdomain_address";
  attemptCount: number;
  createdAt: number;
}

export interface ConversationState {
  threadId: string;
  userId: string;
  pendingCommand?: PendingCommand;
  lastBotQuestion?: string;
  userPreferences?: {
    defaultDuration?: number;
    autoConfirm?: boolean;
  };
}

export type ValidationResult =
  | { valid: true; command: ParsedCommand }
  | {
      valid: false;
      needsClarification: true;
      question: string;
      partial: Partial<ParsedCommand>;
    };

export type CocoParserResult =
  | { success: true; parsed: unknown }
  | {
      success: false;
      errorType: "api_error" | "invalid_json";
      userMessage: string;
      rawResponse?: string;
    };

// ============================================
// Pending registration types
// ============================================

export type RegistrationResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export interface RegistrationCommitment {
  name: string;
  secret: `0x${string}`;
  commitment: `0x${string}`;
  owner: `0x${string}`;
  durationSec: bigint;
  domainPriceWei: bigint;
}

export interface RegistrationCostEstimate {
  commitGasWei: bigint;
  commitGasEth: string;
  registerGasWei: bigint; // Estimate in phase 1, actual in phase 2
  registerGasEth: string;
  isRegisterEstimate: boolean; // true in phase 1, false in phase 2
}

export interface PendingRegistration {
  phase:
    | "awaiting_commit_confirmation"
    | "commit_pending"
    | "awaiting_register_confirmation";
  names: RegistrationCommitment[];
  costs: RegistrationCostEstimate;
  totalDomainCostWei: bigint;
  totalDomainCostEth: string;
  grandTotalWei: bigint;
  grandTotalEth: string;
  commitTxHash?: `0x${string}`; // Set after commit tx sent
  commitTimestamp?: number; // Set after commit tx confirmed
  selectedWallet?: `0x${string}`;
  walletCheckResult?: EOAWalletCheckResult;
}
// ============================================
// Valid Actions
// ============================================

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
  "question",
] as const;

export type VALID_ACTIONS = (typeof VALID_ACTIONS_LIST)[number];

export const QUESTION_TYPES = [
  "pricing",
  "duration",
  "records",
  "process",
  "general",
  "subdomains",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

// ============================================
// ENS Records
// ============================================

export interface EnsRecords {
  address?: string;
  twitter?: string;
  github?: string;
  email?: string;
  url?: string;
  avatar?: string;
  description?: string;
}

// ============================================
// Base Command Types
// ============================================

export type BaseCommand = {
  needsClarification?: boolean;
  clarificationQuestion?: string;
};

export type CommandOptions = {
  batch?: boolean;
  filter?: "expiring" | "all";
};

// ============================================
// Command Definitions
// ============================================

export interface CheckCommand extends BaseCommand {
  action: "check";
  names: string[];
}

export interface RegisterCommand extends BaseCommand {
  action: "register";
  names: string[];
  duration: number;
  options?: CommandOptions; // Made optional to fix type mismatch
}

export interface RenewCommand extends BaseCommand {
  action: "renew";
  names: string[];
  duration: number;
  options?: CommandOptions; // Made optional to fix type mismatch
}

export interface TransferCommand extends BaseCommand {
  action: "transfer";
  names: string[];
  recipient: string;
}

export interface SetCommand extends BaseCommand {
  action: "set";
  names: string[];
  records: EnsRecords;
}

export interface PortfolioCommand extends BaseCommand {
  action: "portfolio";
  address: Address;
  // options?: CommandOptions;
}

// For clarification flow when we don't have all info yet
export interface CompleteSubdomainInfo {
  parent: string;
  label: string;
  resolveAddress: Address;
  owner: Address;
}

// Complete subdomain info with all required fields
export interface SubdomainInfo {
  parent?: string;
  label?: string;
  resolveAddress?: Address;
  owner?: Address;
}
export interface SubdomainCommand extends BaseCommand {
  action: "subdomain";
  names: string[];
  subdomain?: SubdomainInfo;
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
  names: string[];
}

export interface QuestionCommand extends BaseCommand {
  action: "question";
  questionType: QuestionType;
  questionText: string;
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
  | HelpCommand
  | QuestionCommand;

// ============================================
// Event Types (from Towns Bot SDK)
// ============================================

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
    | "migrate"
    | "test_bridge";
  args: string[];
  mentions: Pick<ChannelMessage_Post_Mention, "userId" | "displayName">[];
  replyId: string | undefined;
  threadId: string | undefined;
};

export type OnMessageEventType = BasePayload & {
  message: string;
  replyId: string | undefined;
  threadId: string | undefined;
  mentions: Pick<ChannelMessage_Post_Mention, "userId" | "displayName">[];
  isMentioned: boolean;
};

/**
 * Wallet balance info for both L1 and L2
 */
export interface WalletBalanceInfo {
  address: `0x${string}`;
  l1Balance: bigint;
  l1BalanceEth: string;
  l2Balance: bigint;
  l2BalanceEth: string;
  totalBalance: bigint;
  totalBalanceEth: string;
}

/**
 * Result of checking all EOA wallets
 */
export interface EOAWalletCheckResult {
  wallets: WalletBalanceInfo[];
  hasWalletWithSufficientL1: boolean;
  hasWalletWithSufficientL2ForBridge: boolean;
  bestWalletForL1: WalletBalanceInfo | null;
  bestWalletForBridge: WalletBalanceInfo | null;
}
