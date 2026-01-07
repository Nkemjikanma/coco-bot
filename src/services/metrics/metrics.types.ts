export type MetricEvent =
  // Command events
  | "command_received"

  // Registration events
  | "registration_started"
  | "registration_completed"
  | "registration_failed"
  | "commit_completed"
  | "commit_failed"

  // Transfer events
  | "transfer_started"
  | "transfer_completed"
  | "transfer_failed"

  // Subdomain events
  | "subdomain_started"
  | "subdomain_created"
  | "subdomain_step1_completed"
  | "subdomain_step1_failed"
  | "subdomain_step2_completed"
  | "subdomain_step2_failed"
  | "subdomain_step3_completed"
  | "subdomain_step3_failed"

  // Bridge events
  | "bridge_initiated"
  | "bridge_completed"
  | "bridge_failed"

  // Error events
  | "error_occurred"
  | "renew_started"
  | "renew_failed"
  | "renew_compoleted";

export interface TransactionMetric {
  type: "registration" | "transfer" | "subdomain" | "bridge" | "renew";
  name?: string;
  gasUsed?: string;
  costWei?: string;
  costEth?: string;
  txHash?: string;
  userId: string;
  timestamp: number;
}
