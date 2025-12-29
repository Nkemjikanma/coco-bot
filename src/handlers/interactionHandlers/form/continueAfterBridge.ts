import { BotHandler } from "@towns-protocol/bot";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  updatePendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { OnInteractionEventType, FormCase } from "../types";
import { checkBalance } from "../../../utils";
import { CHAIN_IDS } from "../../../services/bridge";
import { formatEther, hexToBytes } from "viem";
import { encodeCommitData } from "../../../services/ens";
import { ENS_CONTRACTS } from "../../../services/ens/constants";
import { clearBridge } from "../../../db/bridgeStore";

export async function continueAfterBridge(
  handler: BotHandler,
  event: OnInteractionEventType,
  bridgeForm: FormCase,
  userState: UserState,
  userTownWallet: `0x${string}` | null,
) {
  const { userId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);

  const validThreadId =
    event.threadId ?? userState.activeThreadId ?? event.eventId;

  if (!bridgeForm) {
    return;
  }

  for (const component of bridgeForm.components) {
    if (component.component.case === "button" && component.id === "cancel") {
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await clearBridge(userId, validThreadId);

      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId: validThreadId,
      });
      return;
    }

    if (component.component.case === "button" && component.id === "continue") {
      // Verify user now has enough L1 balance
      const partialCommand = userState?.pendingCommand?.partialCommand;

      if (!partialCommand || partialCommand.action !== "register") {
        await handler.sendMessage(
          channelId,
          "Lost track of your registration. Please start again.",
          { threadId: validThreadId },
        );
        return;
      }

      if (!registration.success || !registration.data) {
        await handler.sendMessage(
          channelId,
          "Registration data expired. Please start again.",
          { threadId: validThreadId },
        );
        return;
      }

      // Re-check L1 balance
      const owner = registration.data.names[0].owner;
      const l1Balance = await checkBalance(owner, CHAIN_IDS.MAINNET);
      const requiredAmount = registration.data.grandTotalWei;

      if (l1Balance.balance < requiredAmount) {
        await handler.sendMessage(
          channelId,
          `⏳ Your bridged ETH may not have arrived yet.

     **Current L1 Balance:** ${formatEther(l1Balance.balance)} ETH
     **Required:** ~${formatEther(requiredAmount)} ETH

     Bridging can take 10-20 minutes. Please wait and try again.`,
          { threadId: validThreadId },
        );

        // Send another continue button
        await handler.sendInteractionRequest(
          channelId,
          {
            case: "form",
            value: {
              id: `continue_after_bridge:${validThreadId}`,
              title: "Check Balance & Continue",
              components: [
                {
                  id: "continue",
                  component: {
                    case: "button",
                    value: { label: "🔄 Check Again & Continue" },
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

      // Balance is sufficient - proceed with commit
      await handler.sendMessage(
        channelId,
        `✅ **Balance Confirmed!**

     L1 Balance: ${formatEther(l1Balance.balance)} ETH

     Proceeding with registration...`,
        { threadId: validThreadId },
      );

      // Now send the commit transaction
      const regData = registration.data;
      const firstCommitment = regData.names[0];
      const commitData = encodeCommitData(firstCommitment.commitment);
      const commitmentId = `commit:${userId}:${Date.now()}`;

      await updatePendingRegistration(userId, {
        phase: "commit_pending",
      });

      await handler.sendInteractionRequest(
        channelId,
        {
          case: "transaction",
          value: {
            id: commitmentId,
            title: `Commit ENS Registration: ${firstCommitment.name}`,
            content: {
              case: "evm",
              value: {
                chainId: "1",
                to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                value: "0",
                data: commitData,
                signerWallet: registration.data.selectedWallet || undefined,
              },
            },
          },
        },
        hexToBytes(userId as `0x${string}`),
      );

      return;
    }
  }
}
