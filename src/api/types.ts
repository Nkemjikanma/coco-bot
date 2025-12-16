interface ErrorResponse {
  success: false;
  error: string;
}

interface SuccessResponse<T> {
  success: true;
  data: T;
}

export type ApiResponse<T> = ErrorResponse | SuccessResponse<T>;

// ---------- Name Check ----------
export interface NameCheckData {
  values: NameCheckResponse[];
}

interface NameCheckResponse {
  name: string;
  isAvailable: boolean; // is name avail?
  owner?: Address; // if itn't, owner. if is available undefined
  expiration?: DateLike; // if itn't, expiration. if is available undefined
  registerationPrice?: Cost; // if avail, price. if not, undefnied
}

// ---------- Expiry ----------
export interface ExpiryData {
  values: GetExpiryResponse[];
}

export interface GetExpiryResponse {
  name: string;
  /** When the registration expires */
  expiryDate: DateLike;

  /** 90 days after expiry (when anyone can register it again) */
  gracePeriodEnd: DateLike;

  /** Has it passed the expiry date? */
  isExpired: boolean;

  /** Expired but still in 90-day grace period */
  isInGracePeriod: boolean;

  /** Convenience for display */
  daysUntilExpiry: number;
}

// ---------- getHistory ----------
export type ENSHistoryEventType =
  | "registration"
  | "renewal"
  | "transfer"
  | "recordsUpdated";

export interface ENSHistoryEventBase {
  type: ENSHistoryEventType;
  timestamp: DateLike;
  transactionHash: TxHash;
}

export interface ENSHistoryRegistrationEvent extends ENSHistoryEventBase {
  type: "registration";
  to: Address; // registrant
  duration?: number; // years
  cost?: Cost;
}

export interface ENSHistoryRenewalEvent extends ENSHistoryEventBase {
  type: "renewal";
  to?: Address; // sometimes known (payer/owner), optional
  duration?: number; // years
  cost?: Cost;
}

export interface ENSHistoryTransferEvent extends ENSHistoryEventBase {
  type: "transfer";
  from: Address;
  to: Address;
}

export interface ENSHistoryRecordsUpdatedEvent extends ENSHistoryEventBase {
  type: "recordsUpdated";
  from?: Address; // updater, if you can infer
  to?: Address; // owner/target, if relevant
}

export type ENSHistoryEvent =
  | ENSHistoryRegistrationEvent
  | ENSHistoryRenewalEvent
  | ENSHistoryTransferEvent
  | ENSHistoryRecordsUpdatedEvent;

export interface HistoryData {
  events: ENSHistoryEvent[];
}

// ---------- getENSPortfolio ----------

export interface ENSPortfolioName {
  /** e.g. "alice.eth" */
  name: string;

  expiryDate: DateLike;
  isExpired: boolean;

  /** Is this set as their primary/reverse record? */
  isPrimary: boolean;
}

export interface PortfolioData {
  names: ENSPortfolioName[];

  /** Number of names owned */
  totalCount: number;

  /** Primary ENS name if set */
  primaryName?: string | null;
}

// ---------- Shared primitives ----------

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;

/**
 * Prefer returning ISO 8601 strings from the backend, but this supports either.
 * - ISO: "2025-12-15T12:34:56Z"
 * - Unix seconds or ms (pick one and be consistent)
 */
export type DateLike = string | number;

/**
 * Money can be tricky. This keeps it flexible:
 * - value: "123000000000000000" (wei as string) recommended
 * - symbol: "ETH"
 */
export interface Cost {
  value: string;
  unit?: "wei" | "gwei" | "eth";
  symbol?: "ETH" | string;
}
