import { initRedis } from "./redisClient";
// Session store - conversation history for Claude context
import {
  appendMessageToSession,
  createSession,
  getRecentMessages,
  sessionExists,
  updateSession,
} from "./sessionStore";

// User state store - user location and pending clarification
import {
  clearUserPendingCommand,
  describePendingCommand,
  getUserState,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  setUserPendingCommand,
  updateUserLocation,
  updateUserPreferences,
  deleteUserState,
} from "./userStateStore";

// Flow store - unified transaction flow management
import {
  // Types

  // Type guards
  isRegistrationFlow,
  isBridgeFlow,
  isSubdomainFlow,
  // CRUD operations
  getActiveFlow,
  setActiveFlow,
  updateActiveFlow,
  updateFlowData,
  updateFlowStatus,
  clearActiveFlow,
  hasAnyActiveFlow,
  clearAllUserFlows,
} from "./flow";

import {
  type FlowType,
  type FlowStatus,
  type ActiveFlow,
  type RegistrationFlow,
  type BridgeFlow,
  type SubdomainFlow,
  type RegistrationFlowData,
  type BridgeFlowData,
  type SubdomainFlowData,
} from "./flow.types";

import {
  // Creation helpers
  createRegistrationFlow,
  createBridgeFlow,
  createSubdomainFlow,
  // Utilities
  describeFlow,
  isFlowExpired,
} from "./flow.utils";

export {
  // Redis
  initRedis,

  // Session store
  createSession,
  updateSession,
  getRecentMessages,
  appendMessageToSession,
  sessionExists,

  // User state store
  getUserState,
  setUserPendingCommand,
  clearUserPendingCommand,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  updateUserLocation,
  updateUserPreferences,
  deleteUserState,
  describePendingCommand,

  // Flow store - types
  type FlowType,
  type FlowStatus,
  type ActiveFlow,
  type RegistrationFlow,
  type BridgeFlow,
  type SubdomainFlow,
  type RegistrationFlowData,
  type BridgeFlowData,
  type SubdomainFlowData,

  // Flow store - type guards
  isRegistrationFlow,
  isBridgeFlow,
  isSubdomainFlow,

  // Flow store - CRUD
  getActiveFlow,
  setActiveFlow,
  updateActiveFlow,
  updateFlowData,
  updateFlowStatus,
  clearActiveFlow,
  hasAnyActiveFlow,
  clearAllUserFlows,

  // Flow store - creation helpers
  createRegistrationFlow,
  createBridgeFlow,
  createSubdomainFlow,

  // Flow store - utilities
  describeFlow,
  isFlowExpired,
};
