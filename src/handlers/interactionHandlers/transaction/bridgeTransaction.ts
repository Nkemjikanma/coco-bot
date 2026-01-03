import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import { clearUserPendingCommand, UserState } from "../../../db/userStateStore";
import { formatEther } from "viem";
import { CHAIN_IDS } from "../../../services/bridge";
import { checkBalance } from "../../../utils";
import {
  extractDepositId,
  pollBridgeStatus,
} from "../../../services/bridge/bridge";
import {
  BridgeFlowData,
  clearActiveFlow,
  getActiveFlow,
  isBridgeFlow,
  RegistrationFlowData,
  updateFlowData,
  updateFlowStatus,
} from "../../../db";

export async function bridgeTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
) {
  const { userId, channelId } = event;
  const threadId = event.threadId || event.eventId;

  // Debug logging
  console.log("=== BRIDGE TRANSACTION RESPONSE ===");
  console.log("tx:", JSON.stringify(tx, null, 2));
  console.log("validThreadId:", threadId);
  console.log("===================================");

  // Validate request ID
  if (tx.requestId !== `bridge:${userId}:${threadId}`) {
    console.error("RequestId mismatch:", {
      expected: `bridge:${userId}:${threadId}`,
      received: tx.requestId,
    });
    await handler.sendMessage(
      channelId,
      "⚠️ Received unexpected bridge response. Please try again.",
      { threadId },
    );
    return;
  }

  // Get flow state
  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success) {
    await handler.sendMessage(
      channelId,
      "❌ Bridge state not found. Please start again.",
      { threadId },
    );
    return;
  }

  if (!isBridgeFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      `Invalid flow type. Expected bridge flow. Please start again.`,
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const bridgeData = flow.data;

  // Handle transaction rejection/failure
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    console.log("Bridge transaction rejected - no valid txHash");
    await handleBridgeFailure(
      handler,
      channelId,
      threadId,
      userId,
      bridgeData,
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
    { threadId },
  );

  // Update flow with tx hash and status
  await updateFlowData(userId, threadId, {
    bridgeTxHash: txHash,
    bridgeTimestamp: Date.now(),
  });
  await updateFlowStatus(userId, threadId, "step1_pending");

  // Extract deposit ID from transaction receipt
  const depositId = await extractDepositId(txHash, CHAIN_IDS.BASE);

  if (!depositId) {
    console.warn(
      "Couldn't extract deposit ID, falling back to balance polling",
    );
    await handler.sendMessage(
      channelId,
      `⚠️ Couldn't track bridge directly. Monitoring your Mainnet balance instead...`,
      { threadId },
    );

    // Fallback to balance polling
    await pollForBalanceIncrease(
      handler,
      channelId,
      threadId,
      userId,
      bridgeData.userWallet,
      bridgeData.amountWei,
      bridgeData,
    );
    return;
  }

  // Poll Across API for bridge completion
  pollBridgeStatus(
    txHash,
    async (status) => {
      if (status.status === "filled") {
        await handleBridgeSuccess(
          handler,
          channelId,
          threadId,
          userId,
          bridgeData,
          txHash,
          depositId,
          status.fillTx,
        );
      } else if (status.status === "expired") {
        await handleBridgeFailure(
          handler,
          channelId,
          threadId,
          userId,
          bridgeData,
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
          { threadId },
        );

        // Show continue button for manual continuation
        await sendContinueButton(handler, channelId, threadId, userId);
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
  bridgeData: BridgeFlowData,
  txHash: `0x${string}`,
  depositId: string,
  fillTxHash?: string,
) {
  // Update flow status to complete
  await updateFlowStatus(userId, threadId, "step1_complete");

  await handler.sendMessage(
    channelId,
    `🎉 **Bridge Complete!**\n\n` +
      `Your ETH has arrived on Ethereum Mainnet.\n` +
      (fillTxHash ? `**Fill Tx:** \`${fillTxHash}\`\n\n` : "\n") +
      `Checking your balance...`,
    { threadId },
  );

  // Check if this bridge was for a registration
  if (
    bridgeData.nextAction === "continue_registration" &&
    bridgeData.registrationData
  ) {
    // Continue with registration
    await handlePostBridgeRegistration(
      handler,
      channelId,
      threadId,
      userId,
      bridgeData.registrationData,
    );
  } else {
    // Just a standalone bridge - show balance and complete
    const newBalance = await checkBalance(
      bridgeData.userWallet,
      CHAIN_IDS.MAINNET,
    );

    await handler.sendMessage(
      channelId,
      `💰 **Mainnet Balance:** ${newBalance.balanceEth} ETH\n\n` +
        `Bridge complete! ✅`,
      { threadId },
    );

    await clearActiveFlow(userId, threadId);
  }
}

/**
 * Handle bridge failure
 */
async function handleBridgeFailure(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  bridgeData: BridgeFlowData,
  errorMessage: string,
) {
  // Update flow status to failed
  await updateFlowStatus(userId, threadId, "failed");

  await handler.sendMessage(
    channelId,
    `❌ **Bridge Failed**\n\n${errorMessage}\n\nPlease try again.`,
    { threadId },
  );

  // Clean up all state
  await clearActiveFlow(userId, threadId);
  await clearUserPendingCommand(userId);
}

/**
 * Handle registration after bridge completes
 */
export async function handlePostBridgeRegistration(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  registrationData: RegistrationFlowData,
) {
  const selectedWallet =
    registrationData.selectedWallet || registrationData.commitment?.owner;

  if (!selectedWallet) {
    await handler.sendMessage(
      channelId,
      "❌ No wallet selected. Please start again.",
      { threadId },
    );
    return;
  }

  // Verify balance on Mainnet
  const mainnetBalance = await checkBalance(
    selectedWallet,
    CHAIN_IDS.MAINNET,
    registrationData.grandTotalWei,
  );

  if (!mainnetBalance.sufficient) {
    await handler.sendMessage(
      channelId,
      `⚠️ **Balance Check**\n\n` +
        `Your Mainnet balance: ${mainnetBalance.balanceEth} ETH\n` +
        `Required: ${registrationData.grandTotalEth} ETH\n\n` +
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
      `Ready to register **${registrationData.name}**!`,
    { threadId },
  );

  // Clear bridge flow - we'll create a registration flow when they confirm
  await clearActiveFlow(userId, threadId);

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
    { threadId },
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
    { threadId },
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
  bridgeData: BridgeFlowData,
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

        // Check if we should continue with registration
        if (
          bridgeData.nextAction === "continue_registration" &&
          bridgeData.registrationData
        ) {
          await handlePostBridgeRegistration(
            handler,
            channelId,
            threadId,
            userId,
            bridgeData.registrationData,
          );
        } else {
          await handler.sendMessage(channelId, `Bridge complete! ✅`, {
            threadId,
          });
          await clearActiveFlow(userId, threadId);
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
            `Couldn't detect bridged funds within 2 minutes.\n` +
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
