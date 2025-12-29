import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { getBridgeState, updateBridgeState } from "../../../db";
import { RegisterCommand } from "../../../types";
import { hexToBytes } from "viem";
import { clearBridge } from "../../../db/bridgeStore";

export async function bridgeTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {
  const { userId, channelId, threadId, eventId } = event;

  const pendingRegistration = await getPendingRegistration(userId);
  const validThreadId =
    threadId?.toString() ?? userState?.activeThreadId ?? eventId;

  if (tx.requestId !== `bridge:${userId}:${validThreadId}`) {
    await handler.sendMessage(
      channelId,
      "Couldn't reach the correct bridge. Something is wrong",
      { threadId: validThreadId },
    );
    return;
  }

  const bridgeState = await getBridgeState(userId, validThreadId);
  if (!bridgeState.success) {
    await handler.sendMessage(
      channelId,
      "Couldn't retrieve bridge state. Something went wrong.",
      { threadId: validThreadId },
    );
    return;
  }

  // Check transaction status

  // DETAILED LOGGING: Log transaction response structure
  console.log("=== BRIDGE TRANSACTION RESPONSE ===");
  console.log("Full tx object:", JSON.stringify(tx, null, 2));
  console.log("Transaction details:", {
    requestId: tx.requestId,
    txHash: tx.txHash,
    txHashType: typeof tx.txHash,
    txHashLength: tx.txHash?.length,
    isTxHashTruthy: !!tx.txHash,
    isTxHashEmptyString: tx.txHash === "",
    isTxHashUndefined: tx.txHash === undefined,
    isTxHashNull: tx.txHash === null,
  });
  console.log("Event context:", {
    userId,
    channelId,
    threadId,
    eventId,
    validThreadId,
  });
  console.log("===================================");
  // DEFENSIVE CHECK: Validate tx object structure
  if (!tx || typeof tx !== "object") {
    console.error("ERROR: tx object is invalid or missing:", tx);
    await updateBridgeState(userId, validThreadId, {
      ...bridgeState.data,
      status: "failed",
    });
    await clearBridge(userId, validThreadId); // ADD - clear after marking failed
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    await handler.sendMessage(
      channelId,
      "❌ Bridging failed - invalid response structure. Please try again or bridge manually.",
      { threadId: validThreadId },
    );
    return;
  }
  // DEFENSIVE CHECK: Check if txHash field exists
  if (!("txHash" in tx)) {
    console.error("ERROR: txHash field missing from response:", tx);
    await updateBridgeState(userId, validThreadId, {
      ...bridgeState.data,
      status: "failed",
    });

    await clearBridge(userId, validThreadId); // ADD - clear after marking failed
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    await handler.sendMessage(
      channelId,
      "❌ Bridging failed - txHash field missing. Please try again or bridge manually.",
      { threadId: validThreadId },
    );
    return;
  }
  // Check transaction status - handle empty string, null, undefined
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    console.log("Bridge transaction rejected or failed - no valid txHash");
    await updateBridgeState(userId, validThreadId, {
      ...bridgeState.data,
      status: "failed",
    });

    await clearBridge(userId, validThreadId); // ADD - clear after marking failed
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    await handler.sendMessage(
      channelId,
      "❌ Bridging failed. Please try again or bridge manually.",
      { threadId: validThreadId },
    );
    return;
  }
  console.log("✅ Bridge transaction has valid txHash:", tx.txHash);
  // if (!tx.txHash) {
  //   await updateBridgeState(userId, validThreadId, {
  //     ...bridgeState.data,
  //     status: "failed",
  //   });
  //   await handler.sendMessage(
  //     channelId,
  //     "❌ Bridging failed. Please try again or bridge manually.",
  //     { threadId: validThreadId },
  //   );
  //   return;
  // }

  // Bridge transaction submitted successfully
  await updateBridgeState(userId, validThreadId, {
    ...bridgeState.data,
    status: "bridging",
    depositTxHash: tx.txHash,
  });

  await handler.sendMessage(
    channelId,
    `✅ **Bridge Transaction Submitted!**

**Tx Hash:** ${tx.txHash}

⏳ Please note: Bridging can take 1-5 minutes to finalize on L1. Once confirmed, we'll continue with your registration.`,
    { threadId: validThreadId },
  );

  // Check if we have pending registration
  if (!pendingRegistration.success || !pendingRegistration.data) {
    await handler.sendMessage(
      channelId,
      "Registration data expired. Please start again with `/register`",
      { threadId: validThreadId },
    );
    return;
  }

  // Check if we have the pending command
  if (!userState?.pendingCommand?.partialCommand) {
    await handler.sendMessage(
      channelId,
      "Lost track of your registration. Please start again with `/register`",
      { threadId: validThreadId },
    );
    return;
  }

  // Reconstruct the command from pending state
  const partialCommand = userState.pendingCommand.partialCommand;

  if (
    partialCommand.action !== "register" ||
    !partialCommand.names ||
    !partialCommand.duration
  ) {
    await handler.sendMessage(
      channelId,
      "Something went wrong with the registration data. Please start again.",
      { threadId: validThreadId },
    );
    return;
  }

  const command: RegisterCommand = {
    action: "register",
    names: partialCommand.names,
    duration: partialCommand.duration,
  };

  // Prompt user to continue
  await handler.sendInteractionRequest(
    channelId,
    {
      case: "form",
      value: {
        id: `continue_after_bridge:${validThreadId}`,
        title: "Continue Registration",
        components: [
          {
            id: "continue",
            component: {
              case: "button",
              value: { label: "✅ Continue Registration" },
            },
          },
          {
            id: "cancel",
            component: {
              case: "button",
              value: { label: "❌ Cancel" },
            },
          },
        ],
      },
    },
    hexToBytes(userId as `0x${string}`),
  );

  return;
}
