// Flow store - unified transaction flow management
import {
  clearActiveFlow,
  clearAllUserFlows,
  // CRUD operations
  getActiveFlow,
  hasAnyActiveFlow,
  isBridgeFlow,
  // Types

  // Type guards
  isRegistrationFlow,
  isSubdomainFlow,
  setActiveFlow,
  updateActiveFlow,
  updateFlowData,
  updateFlowStatus,
} from "./flow";
import type {
  ActiveFlow,
  BridgeFlow,
  BridgeFlowData,
  FlowStatus,
  FlowType,
  RegistrationFlow,
  RegistrationFlowData,
  SubdomainFlow,
  SubdomainFlowData,
} from "./flow.types";
import {
  createBridgeFlow,
  // Creation helpers
  createRegistrationFlow,
  createSubdomainFlow,
  // Utilities
  describeFlow,
  isFlowExpired,
} from "./flow.utils";
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
  deleteUserState,
  describePendingCommand,
  getUserState,
  setUserPendingCommand,
  updateUserLocation,
  updateUserPreferences,
} from "./userStateStore";

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
