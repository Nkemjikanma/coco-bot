import { FLOW_TTL } from "./flow";
import {
  RegistrationFlowData,
  FlowStatus,
  RegistrationFlow,
  BridgeFlowData,
  BridgeFlow,
  SubdomainFlowData,
  SubdomainFlow,
  ActiveFlow,
  TransferFlowData,
  TransferFlow,
} from "./flow.types";

/**
 * Create a new registration flow
 */
export function createRegistrationFlow(params: {
  userId: string;
  threadId: string;
  channelId: string;
  status: FlowStatus;
  data: RegistrationFlow["data"];
}): RegistrationFlow {
  return {
    type: "registration",
    userId: params.userId,
    threadId: params.threadId,
    channelId: params.channelId,
    status: params.status,
    data: params.data,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Create a new bridge flow
 */
export function createBridgeFlow(params: {
  userId: string;
  threadId: string;
  channelId: string;
  status: FlowStatus;
  data: BridgeFlow["data"];
}): BridgeFlow {
  return {
    type: "bridge",
    userId: params.userId,
    threadId: params.threadId,
    channelId: params.channelId,
    status: params.status,
    data: params.data,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Create a new subdomain flow
 */
export function createSubdomainFlow(params: {
  userId: string;
  threadId: string;
  channelId: string;
  status: FlowStatus;
  data: SubdomainFlow["data"];
}): SubdomainFlow {
  return {
    type: "subdomain",
    userId: params.userId,
    threadId: params.threadId,
    channelId: params.channelId,
    status: params.status,
    data: params.data,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Create a new transfer flow
 */
export function createTransferFlow(params: {
  userId: string;
  threadId: string;
  channelId: string;
  status: FlowStatus;
  data: TransferFlow["data"];
}): TransferFlow {
  return {
    type: "transfer",
    userId: params.userId,
    threadId: params.threadId,
    channelId: params.channelId,
    status: params.status,
    data: params.data,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ============ Utility Functions ============
/**
 * Get human-readable description of a flow
 */
export function describeFlow(flow: ActiveFlow): string {
  switch (flow.type) {
    case "registration":
      const regData = flow.data as RegistrationFlowData;
      const name = regData.name;
      return `Registering ${name}`;

    case "bridge":
      const bridgeData = flow.data as BridgeFlowData;
      return `Bridging ${bridgeData.amountEth} ETH`;

    case "subdomain":
      const subData = flow.data as SubdomainFlowData;
      return `Creating subdomain ${subData.fullName}`;

    default:
      return "Unknown flow";
  }
}

/**
 * Check if a flow has expired based on updatedAt
 */
export function isFlowExpired(
  flow: ActiveFlow,
  maxAgeMs: number = FLOW_TTL * 1000,
): boolean {
  return Date.now() - flow.updatedAt > maxAgeMs;
}
