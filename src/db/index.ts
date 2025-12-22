import { initRedis } from "./redisClient";
import {
  appendMessageToSession,
  createSession,
  getRecentMessages,
  sessionExists,
  updateSession,
} from "./sessionStore";
import {
  clearUserPendingCommand,
  describePendingCommand,
  getUserState,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  setUserPendingCommand,
  updateUserLocation,
  setPendingRegistration,
  getPendingRegistration,
  clearPendingRegistration,
  updatePendingRegistration,
} from "./userStateStore";

import {
  getBridgeState,
  updateBridgeState,
  setBridgeState,
} from "./bridgeStore";
export {
  createSession,
  updateSession,
  getRecentMessages,
  appendMessageToSession,
  initRedis,
  sessionExists,
  getUserState,
  setUserPendingCommand,
  clearUserPendingCommand,
  hasPendingCommandElsewhere,
  movePendingCommandToThread,
  updateUserLocation,
  describePendingCommand,
  setPendingRegistration,
  getPendingRegistration,
  clearPendingRegistration,
  updatePendingRegistration,
  getBridgeState,
  updateBridgeState,
  setBridgeState,
};
