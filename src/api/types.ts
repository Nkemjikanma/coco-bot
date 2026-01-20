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

export interface NameCheckResponse {
	name: string;
	isAvailable: boolean;
	owner?: Address;
	expiration?: Date;
	// registrationPrice?: Cost;
	registrationPrice?: string;
	error?: string; // Add this
}

// ---------- Expiry ----------
export interface ExpiryData {
	values: GetExpiryResponse[];
}

export interface GetExpiryResponse {
	name: string;
	/** When the registration expires */
	expiryDate?: Date;

	/** 90 days after expiry (when anyone can register it again) */
	gracePeriodEnd?: Date;

	/** Has it passed the expiry date? */
	isExpired?: boolean;

	/** Expired but still in 90-day grace period */
	isInGracePeriod?: boolean;

	/** Convenience for display */
	daysUntilExpiry?: number;
	error?: string; // error
}

// ---------- getHistory ----------
export type ENSHistoryEventType =
	| "registered"
	| "renewed"
	| "transferred"
	| "wrapped"
	| "unwrapped"
	| "expiry_extended";

export interface ENSHistoryEventBase {
	type: ENSHistoryEventType;
	blockNumber: number;
	transactionHash: string;
}

export interface ENSHistoryRegistrationEvent extends ENSHistoryEventBase {
	type: "registered";
	to: string;
	expiryDate: string;
}

export interface ENSHistoryRenewalEvent extends ENSHistoryEventBase {
	type: "renewed";
	expiryDate: string;
}

export interface ENSHistoryTransferEvent extends ENSHistoryEventBase {
	type: "transferred";
	to: string;
}

export interface ENSHistoryWrappedEvent extends ENSHistoryEventBase {
	type: "wrapped";
	owner: string;
	expiryDate: string;
}

export interface ENSHistoryUnwrappedEvent extends ENSHistoryEventBase {
	type: "unwrapped";
	owner: string;
}

export interface ENSHistoryExpiryExtendedEvent extends ENSHistoryEventBase {
	type: "expiry_extended";
	expiryDate: string;
}

export type ENSHistoryEvent =
	| ENSHistoryRegistrationEvent
	| ENSHistoryRenewalEvent
	| ENSHistoryTransferEvent
	| ENSHistoryWrappedEvent
	| ENSHistoryUnwrappedEvent
	| ENSHistoryExpiryExtendedEvent;

export interface HistoryData {
	events: ENSHistoryEvent[];
}

// ---------- getENSPortfolio ----------

export interface ENSPortfolioName {
	/** e.g. "alice.eth" */
	name: string;

	expiryDate: Date;
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
