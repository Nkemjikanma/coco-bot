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
import { encodeCommitData, prepareRegistration } from "../../../services/ens";
import { ENS_CONTRACTS } from "../../../services/ens/constants";
import { clearBridge } from "../../../db/bridgeStore";

export async function continueAfterBridge(
  handler: BotHandler,
  event: OnInteractionEventType,
  bridgeForm: FormCase,
  userState: UserState,
) {
  const { userId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);

  const validThreadId = userState.activeThreadId ?? event.threadId ?? channelId;

  if (!bridgeForm) {
    return;
  }

  for (const component of bridgeForm.components) {
    if (component.component.case === "button" && component.id === "cancel") {
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      if (validThreadId) {
        await clearBridge(userId, validThreadId);
      }

      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId: validThreadId || undefined,
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
          { threadId: validThreadId || undefined },
        );
        return;
      }

      if (!registration.success || !registration.data) {
        await handler.sendMessage(
          channelId,
          "Registration data expired. Please start again.",
          { threadId: validThreadId || undefined },
        );
        return;
      }

      // Re-check L1 balance
      const owner = registration.data.selectedWallet!;
      const l1Balance = await checkBalance(owner, CHAIN_IDS.MAINNET);
      const requiredAmount = registration.data.grandTotalWei;

      if (l1Balance.balance < requiredAmount) {
        await handler.sendMessage(
          channelId,
          `⏳ Your bridged ETH may not have arrived yet.

     **Current L1 Balance:** ${formatEther(l1Balance.balance)} ETH
     **Required:** ~${formatEther(requiredAmount)} ETH

     Bridging can take 10-20 minutes. Please wait and try again.`,
          { threadId: validThreadId || undefined },
        );

        // Send another continue button
        await handler.sendInteractionRequest(
          channelId,
          {
            type: "form",
            id: `continue_after_bridge:${validThreadId}`,
            title: "Check Balance & Continue",
            components: [
              {
                id: "continue",
                type: "button",
                label: "🔄 Check Again & Continue",
              },
              {
                id: "cancel",
                type: "button",
                label: "❌ Cancel",
              },
            ],
            recipient: userId as `0x${string}`,
          },
          { threadId: validThreadId },
        );
        return;
      }

      // Balance is sufficient - proceed with commit
      await handler.sendMessage(
        channelId,
        `✅ **Balance Confirmed!**

     L1 Balance: ${formatEther(l1Balance.balance)} ETH

     Proceeding with registration...`,
        { threadId: validThreadId || undefined },
      );

      // Now send the commit transaction
      let regData = registration.data;

      if (
        !regData.names ||
        regData.names.length === 0 ||
        !regData.names[0].commitment
      ) {
        console.log("No commitment found, preparing registration...");

        // Get the domain name from partialCommand
        const domainNames = partialCommand.names;
        const duration = partialCommand.duration || 1;

        if (!domainNames || domainNames.length === 0) {
          await handler.sendMessage(
            channelId,
            "❌ Could not find domain name. Please start again.",
            { threadId: validThreadId || undefined },
          );
          return;
        }

        try {
          // Prepare registration with commitment
          const preparedReg = await prepareRegistration({
            names: domainNames,
            owner: owner,
            durationYears: duration,
          });

          // Update the stored registration with the prepared data
          await updatePendingRegistration(userId, {
            ...preparedReg,
            selectedWallet: owner,
            phase: "commit_pending",
          });

          // Refresh registration data
          const updatedReg = await getPendingRegistration(userId);
          if (!updatedReg.success || !updatedReg.data) {
            throw new Error("Failed to update registration");
          }
          regData = updatedReg.data;
        } catch (error) {
          console.error("Error preparing registration:", error);
          await handler.sendMessage(
            channelId,
            "❌ Failed to prepare registration. Please try again.",
            { threadId: validThreadId || undefined },
          );
          return;
        }
      }

      const firstCommitment = regData.names[0];
      const commitData = encodeCommitData(firstCommitment.commitment);
      const commitmentId = `commit:${userId}:${Date.now()}`;

      await updatePendingRegistration(userId, {
        phase: "commit_pending",
      });

      await handler.sendInteractionRequest(
        channelId,
        {
          type: "transaction",
          id: commitmentId,
          title: `Commit ENS Registration: ${firstCommitment.name}`,
          tx: {
            chainId: "1",
            to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
            value: "0",
            data: commitData,
            signerWallet: registration.data.selectedWallet || undefined,
          },
          recipient: userId as `0x${string}`,
        },
        {
          threadId: validThreadId,
        },
      );
      return;
    }
  }
}
