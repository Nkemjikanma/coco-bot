import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  updatePendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { estimateRegisterGas } from "../../../services/ens/ens";
import { formatEther, hexToBytes } from "viem";
import { ENS_CONTRACTS } from "../../../services/ens/constants";

export async function commitTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {
  const { userId, eventId, channelId, threadId } = event;
  const validThreadId = threadId ?? userState?.activeThreadId ?? eventId;

  if (tx.txHash) {
    // Update registration with tx hash and timestamp
    await updatePendingRegistration(event.userId, {
      phase: "awaiting_register_confirmation",
      commitTxHash: tx.txHash as `0x${string}`,
      commitTimestamp: Date.now(),
    });

    await handler.sendMessage(
      channelId,
      `✅ Commit transaction successful!\n\nTx: ${tx.txHash}\n\n⏳ Please wait ~60 seconds before we can complete the registration. I'll notify you when it's ready.`,
      { threadId },
    );

    // Start the wait timer
    startCommitWaitTimer(handler, channelId, validThreadId, userId);
  } else if (!tx.txHash) {
    await handler.sendMessage(
      channelId,
      "❌ Commit transaction failed. Please try again.",
      { threadId },
    );
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
  }
  return;
}

function startCommitWaitTimer(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
) {
  // Wait 65 seconds to be safe (ENS requires 60 seconds)
  const waitTime = 65 * 1000;

  setTimeout(async () => {
    try {
      const registration = await getPendingRegistration(userId);

      if (!registration.success || !registration.data) {
        // Registration was cancelled or expired
        return;
      }

      if (registration.data.phase !== "awaiting_register_confirmation") {
        // Not in the right phase
        return;
      }

      const commitment = registration.data.names[0];

      // Estimate register gas with actual values from stored commitment
      const gasEstimate = await estimateRegisterGas({
        account: commitment.owner,
        label: commitment.name.replace(/\.eth$/, ""), // Removing .eth suffix
        owner: commitment.owner,
        durationSec: commitment.durationSec,
        secret: commitment.secret,
        resolver: ENS_CONTRACTS.PUBLIC_RESOLVER,
        data: [],
        reverseRecord: false,
        ownerControlledFuses: 0,
        value: commitment.domainPriceWei,
      });

      // update registration
      await updatePendingRegistration(userId, {
        costs: {
          ...registration.data.costs,
          registerGasWei: gasEstimate.gasWei,
          registerGasEth: gasEstimate.gasEth,
          isRegisterEstimate: false, // Now it's accurate
        },
      });

      // Calculate total remaining cost
      const remainingCost = commitment.domainPriceWei + gasEstimate.gasWei;
      const remainingCostEth = formatEther(remainingCost);

      await handler.sendMessage(
        channelId,
        `⏰ **Ready to complete registration!**

The waiting period is over. Let's finish registering **${commitment.name}**.

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
          case: "form",
          value: {
            id: `confirm_register:${threadId}`,
            title: "Complete Registration",
            components: [
              {
                id: "confirm",
                component: {
                  case: "button",
                  value: { label: "✅ Complete Registration" },
                },
              },
              {
                id: "cancel",
                component: { case: "button", value: { label: "❌ Cancel" } },
              },
            ],
          },
        },
        hexToBytes(userId as `0x${string}`),
      );
    } catch (error) {
      console.error("Error in commit wait timer:", error);
    }
  }, waitTime);
}
