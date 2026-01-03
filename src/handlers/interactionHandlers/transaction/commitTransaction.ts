import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import { clearUserPendingCommand } from "../../../db/userStateStore";
import { estimateRegisterGas } from "../../../services/ens/ens";
import { formatEther } from "viem";
import { ENS_CONTRACTS } from "../../../services/ens/constants";
import {
  clearActiveFlow,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowData,
  updateFlowStatus,
} from "../../../db";

export async function commitTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
) {
  const { userId, channelId } = event;
  const threadId = event.threadId || event.eventId;

  const flowResult = await getActiveFlow(userId, threadId);

  if (!flowResult.success) {
    await handler.sendMessage(
      channelId,
      `Something went wrong: ${flowResult.error}. Please start again.`,
      { threadId },
    );
    return;
  }

  if (!isRegistrationFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      `Invalid flow type. Expected registration flow. Please start again.`,
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    return;
  }

  const flow = flowResult.data;
  const regData = flow.data;

  if (tx.txHash) {
    // Update registration with tx hash and timestamp
    await updateFlowData(userId, threadId, {
      commitTxHash: tx.txHash as `0x${string}`,
      commitTimestamp: Date.now(),
    });

    await updateFlowStatus(userId, threadId, "step1_complete");

    await handler.sendMessage(
      channelId,
      `✅ Commit transaction successful!\n\nTx: ${tx.txHash}\n\n⏳ Please wait ~60 seconds before we can complete the registration. I'll notify you when it's ready.`,
      { threadId },
    );

    // Start the wait timer
    startCommitWaitTimer(handler, channelId, userId, threadId);
  } else {
    await handler.sendMessage(
      channelId,
      "❌ Commit transaction failed. Please try again.",
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
  }
  return;
}

function startCommitWaitTimer(
  handler: BotHandler,
  channelId: string,
  userId: string,
  threadId: string,
) {
  // Wait 65 seconds to be safe (ENS requires 60 seconds)
  const waitTime = 65 * 1000;

  setTimeout(async () => {
    try {
      const flowResult = await getActiveFlow(userId, threadId);

      if (!flowResult.success) {
        // Registration was cancelled or expired
        return;
      }

      if (!isRegistrationFlow(flowResult.data)) {
        // Not a registration flow
        return;
      }

      const flow = flowResult.data;
      const regData = flow.data;

      // Check status
      if (flow.status !== "step1_complete") {
        // Not in the right status
        return;
      }

      // Validate we have commitment data
      if (!regData.commitment) {
        console.error("No commitment data found in flow");
        return;
      }

      const { commitment, name, costs } = regData;

      // Estimate register gas with actual values from stored commitment
      const gasEstimate = await estimateRegisterGas({
        account: commitment.owner,
        label: name.replace(/\.eth$/, ""),
        owner: commitment.owner,
        durationSec: commitment.durationSec,
        secret: commitment.secret,
        resolver: ENS_CONTRACTS.PUBLIC_RESOLVER,
        data: [],
        reverseRecord: false,
        ownerControlledFuses: 0,
        value: commitment.domainPriceWei,
      });

      // Update flow data with actual gas estimate
      await updateFlowData(userId, threadId, {
        costs: {
          ...costs,
          registerGasWei: gasEstimate.gasWei,
          registerGasEth: gasEstimate.gasEth,
          isRegisterEstimate: false,
        },
      });

      // Update status to awaiting register confirmation
      await updateFlowStatus(userId, threadId, "step2_pending");

      // Calculate total remaining cost
      const remainingCost = commitment.domainPriceWei + gasEstimate.gasWei;
      const remainingCostEth = formatEther(remainingCost);

      await handler.sendMessage(
        channelId,
        `⏰ **Ready to complete registration!**

The waiting period is over. Let's finish registering **${name}**.

💰 **Final Cost**
├─ Domain price: ${formatEther(commitment.domainPriceWei)} ETH
└─ Register tx gas: ~${gasEstimate.gasEth} ETH

**Total: ~${remainingCostEth} ETH**`,
        { threadId },
      );

      // Send confirmation for register phase
      await handler.sendInteractionRequest(
        channelId,
        {
          type: "form",
          id: `confirm_register:${threadId}`,
          title: "Complete Registration",
          components: [
            {
              id: "confirm",
              type: "button",
              label: "✅ Complete Registration",
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
    } catch (error) {
      console.error("Error in commit wait timer:", error);
    }
  }, waitTime);
}
