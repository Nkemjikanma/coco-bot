import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { getBridgeState, updateBridgeState, clearBridge } from "../../../db";
import { PendingRegistration, RegisterCommand } from "../../../types";
import { formatEther, hexToBytes } from "viem";
import { CHAIN_IDS } from "../../../services/bridge";
import { checkBalance } from "../../../utils";
import {
  extractDepositId,
  pollBridgeStatus,
} from "../../../services/bridge/bridge";

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
  const validThreadId = userState?.activeThreadId ?? threadId;

  // Debug logging
  console.log("=== BRIDGE TRANSACTION RESPONSE ===");
  console.log("tx:", JSON.stringify(tx, null, 2));
  console.log("validThreadId:", validThreadId);
  console.log("===================================");

  // Validate request ID
  if (tx.requestId !== `bridge:${userId}:${validThreadId}`) {
    console.error("RequestId mismatch:", {
      expected: `bridge:${userId}:${validThreadId}`,
      received: tx.requestId,
    });
    await handler.sendMessage(
      channelId,
      "⚠️ Received unexpected bridge response. Please try again.",
      validThreadId ? { threadId: validThreadId } : undefined,
    );
    return;
  }

  // Get bridge state
  const bridgeState = await getBridgeState(userId, validThreadId!);
  if (!bridgeState.success || !bridgeState.data) {
    await handler.sendMessage(
      channelId,
      "❌ Bridge state not found. Please start again.",
      validThreadId ? { threadId: validThreadId } : undefined,
    );
    return;
  }

  // Handle transaction rejection/failure
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    console.log("Bridge transaction rejected - no valid txHash");
    await handleBridgeFailure(
      handler,
      channelId,
      validThreadId,
      userId,
      bridgeState.data,
      "Bridge transaction was rejected or failed.",
    );
    return;
  }

  // Transaction submitted successfully
  const txHash = tx.txHash as `0x${string}`;
  console.log("✅ Bridge transaction submitted:", txHash);

  await handler.sendMessage(
    channelId,
    `✅ **Bridge Transaction Submitted!**\n\n` +
      `**Tx Hash:** \`${txHash}\`\n\n` +
      `⏳ Waiting for bridge completion (usually 1-2 minutes)...`,
    validThreadId ? { threadId: validThreadId } : undefined,
  );

  // Update state to bridging
  await updateBridgeState(userId, validThreadId!, {
    ...bridgeState.data,
    status: "bridging",
    depositTxHash: txHash,
  });

  // Extract deposit ID from transaction receipt
  const depositId = await extractDepositId(txHash, CHAIN_IDS.BASE);

  if (!depositId) {
    console.warn(
      "Couldn't extract deposit ID, falling back to balance polling",
    );
    await handler.sendMessage(
      channelId,
      `⚠️ Couldn't track bridge directly. Monitoring your Mainnet balance instead...`,
      validThreadId ? { threadId: validThreadId } : undefined,
    );

    // Fallback to balance polling
    await pollForBalanceIncrease(
      handler,
      channelId,
      validThreadId!,
      userId,
      bridgeState.data.recipient,
      bridgeState.data.amount,
      userState,
    );
    return;
  }

  // Update with deposit ID
  await updateBridgeState(userId, validThreadId!, {
    ...bridgeState.data,
    status: "bridging",
    depositTxHash: txHash,
    depositId,
  });

  // Poll Across API for bridge completion
  pollBridgeStatus(
    txHash, // Use txHash as depositTxnRef
    async (status) => {
      if (status.status === "filled") {
        await handleBridgeSuccess(
          handler,
          channelId,
          validThreadId!,
          userId,
          bridgeState.data,
          txHash,
          depositId,
          status.fillTx,
          userState,
        );
      } else if (status.status === "expired") {
        await handleBridgeFailure(
          handler,
          channelId,
          validThreadId,
          userId,
          bridgeState.data,
          "Bridge request expired. Your funds should still be on Base.",
        );
      } else {
        // Still pending after max wait
        await handler.sendMessage(
          channelId,
          `⏳ **Bridge Still Processing**\n\n` +
            `The bridge is taking longer than expected.\n` +
            `Please check your Mainnet balance in a few minutes.\n\n` +
            `Once you have funds, click "Continue Registration" below.`,
          validThreadId ? { threadId: validThreadId } : undefined,
        );

        // Show continue button for manual continuation
        await sendContinueButton(handler, channelId, validThreadId!, userId);
      }
    },
    5 * 60 * 1000, // 5 minute max wait
  );
}

/**
 * Handle successful bridge completion
 */
async function handleBridgeSuccess(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  bridgeData: any,
  txHash: string,
  depositId: string,
  fillTxHash?: string,
  userState?: UserState,
) {
  // Update state to completed
  await updateBridgeState(userId, threadId, {
    ...bridgeData,
    status: "completed",
    depositTxHash: txHash,
    depositId,
    fillTxHash,
  });

  await handler.sendMessage(
    channelId,
    `🎉 **Bridge Complete!**\n\n` +
      `Your ETH has arrived on Ethereum Mainnet.\n` +
      (fillTxHash ? `**Fill Tx:** \`${fillTxHash}\`\n\n` : "\n") +
      `Checking your balance...`,
    { threadId },
  );

  // Check pending registration
  const pendingRegistration = await getPendingRegistration(userId);

  if (!pendingRegistration.success || !pendingRegistration.data) {
    // No registration pending - just show balance
    const newBalance = await checkBalance(
      bridgeData.recipient,
      CHAIN_IDS.MAINNET,
    );

    await handler.sendMessage(
      channelId,
      `💰 **Mainnet Balance:** ${newBalance.balanceEth} ETH\n\n` +
        `Bridge complete! ✅`,
      { threadId },
    );

    await clearBridge(userId, threadId);
    return;
  }

  // Continue with registration
  await handlePostBridgeRegistration(
    handler,
    channelId,
    threadId,
    userId,
    pendingRegistration.data,
  );
}

/**
 * Handle bridge failure
 */
async function handleBridgeFailure(
  handler: BotHandler,
  channelId: string,
  threadId: string | undefined,
  userId: string,
  bridgeData: any,
  errorMessage: string,
) {
  await updateBridgeState(userId, threadId!, {
    ...bridgeData,
    status: "failed",
  });

  await handler.sendMessage(
    channelId,
    `❌ **Bridge Failed**\n\n${errorMessage}\n\nPlease try again.`,
    threadId ? { threadId } : undefined,
  );

  // Clean up all state
  await clearBridge(userId, threadId!);
  await clearPendingRegistration(userId);
  await clearUserPendingCommand(userId);
}

/**
 * Handle registration after bridge completes
 */
async function handlePostBridgeRegistration(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  registration: PendingRegistration,
) {
  // Verify balance on Mainnet
  const mainnetBalance = await checkBalance(
    registration.selectedWallet || registration.names[0].owner,
    CHAIN_IDS.MAINNET,
    registration.grandTotalWei,
  );

  if (!mainnetBalance.sufficient) {
    await handler.sendMessage(
      channelId,
      `⚠️ **Balance Check**\n\n` +
        `Your Mainnet balance: ${mainnetBalance.balanceEth} ETH\n` +
        `Required: ${registration.grandTotalEth} ETH\n\n` +
        `The bridged funds may still be arriving. Please wait and try again.`,
      { threadId },
    );

    await sendContinueButton(handler, channelId, threadId, userId);
    return;
  }

  // Balance is sufficient - proceed with commit
  await handler.sendMessage(
    channelId,
    `✅ **Balance Confirmed!**\n\n` +
      `Mainnet Balance: ${mainnetBalance.balanceEth} ETH\n\n` +
      `Ready to register **${registration.names.map((n) => n.name).join(", ")}**!`,
    { threadId },
  );

  // Clear bridge state since we're done with bridging
  await clearBridge(userId, threadId);

  // Send commit confirmation
  await handler.sendInteractionRequest(
    channelId,
    {
      type: "form",
      id: `confirm_commit:${threadId}`,
      title: "Confirm Registration: Step 1 of 2",
      components: [
        {
          id: "confirm",
          type: "button",
          label: "✅ Start Registration",
        },
        {
          id: "cancel",
          type: "button",
          label: "❌ Cancel",
        },
      ],
      recipient: userId as `0x${string}`,
    },
    {
      threadId,
    },
  );
}

/**
 * Send continue/cancel buttons
 */
async function sendContinueButton(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
) {
  await handler.sendInteractionRequest(
    channelId,
    {
      type: "form",
      id: `continue_after_bridge:${threadId}`,
      title: "Continue Registration",
      components: [
        {
          id: "continue",
          type: "button",
          label: "🔄 Check Balance & Continue",
        },
        {
          id: "cancel",
          type: "button",
          label: "❌ Cancel",
        },
      ],
      recipient: userId as `0x${string}`,
    },
    {
      threadId,
    },
  );
}

/**
 * Fallback: Poll for balance increase on Mainnet
 */
async function pollForBalanceIncrease(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  address: `0x${string}`,
  expectedIncrease: bigint,
  userState?: UserState,
) {
  const initialBalance = await checkBalance(address, CHAIN_IDS.MAINNET);

  const maxWaitMs = 2 * 60 * 1000; // 2 minutes
  const pollIntervalMs = 10 * 1000; // 10 seconds
  const startTime = Date.now();

  const poll = async () => {
    try {
      const currentBalance = await checkBalance(address, CHAIN_IDS.MAINNET);

      // Check if balance increased (at least 80% of expected to account for fees)
      const threshold = (expectedIncrease * 80n) / 100n;
      const balanceIncrease = currentBalance.balance - initialBalance.balance;

      if (balanceIncrease >= threshold) {
        await handler.sendMessage(
          channelId,
          `🎉 **Funds Detected on Mainnet!**\n\n` +
            `New Balance: ${currentBalance.balanceEth} ETH\n` +
            `Increase: +${formatEther(balanceIncrease)} ETH`,
          { threadId },
        );

        // Continue with registration if applicable
        const pendingRegistration = await getPendingRegistration(userId);

        if (pendingRegistration.success && pendingRegistration.data) {
          await handlePostBridgeRegistration(
            handler,
            channelId,
            threadId,
            userId,
            pendingRegistration.data,
          );
        } else {
          await handler.sendMessage(channelId, `Bridge complete! ✅`, {
            threadId,
          });
          await clearBridge(userId, threadId);
        }
        return;
      }

      // Continue polling if within time limit
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollIntervalMs);
      } else {
        // Timeout - show manual continue option
        await handler.sendMessage(
          channelId,
          `⏳ **Bridge Timeout**\n\n` +
            `Couldn't detect bridged funds within 5 minutes.\n` +
            `Current Mainnet balance: ${currentBalance.balanceEth} ETH\n\n` +
            `The bridge may still be processing. Click below when ready.`,
          { threadId },
        );

        await sendContinueButton(handler, channelId, threadId, userId);
      }
    } catch (error) {
      console.error("Error polling balance:", error);
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollIntervalMs);
      }
    }
  };

  poll();
}
