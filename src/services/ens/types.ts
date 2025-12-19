export interface ENSAvailabilityResult {
  label: string;
  fullName: string;
  available: boolean;
  valid: boolean;
  reason?: string;
  priceEth?: string;
}

export interface ENSExpiryResult {
  label: string;
  fullName: string;
  valid: boolean;
  registered: boolean;
  expirationDate?: Date;
  daysUntilExpiry?: number;
  expired?: boolean;
  inGracePeriod?: boolean;
  gracePeriodEnds?: Date;
  owner?: string;
  registrant?: string;
  reason?: string;
}

export interface ENSUserPortfolio {
  address: string;
  totalDomains: number;
  activeDomains: number;
  expiredDomains: number;
  expiringSoon: number;
  inGracePeriod: number;
  domains: ENSExpiryResult[];
}

// Domain History Types
export interface ENSHistoryEvent {
  type:
    | "registered"
    | "renewed"
    | "transferred"
    | "resolver_changed"
    | "wrapped"
    | "unwrapped"
    | "expiry_extended";
  blockNumber: number;
  transactionHash: string;
  timestamp?: Date;
  details: string;
}

export interface ENSHistoryResult {
  label: string;
  fullName: string;
  valid: boolean;
  registered: boolean;
  reason?: string;

  // Current state
  currentOwner?: string;
  currentRegistrant?: string;
  expiryDate?: Date;
  createdAt?: Date;

  // Registration info
  registrationDate?: Date;
  registrationCost?: string;
  initialRegistrant?: string;

  // Events history
  events: ENSHistoryEvent[];

  // Stats
  totalTransfers: number;
  totalRenewals: number;
  totalResolverChanges: number;
}
