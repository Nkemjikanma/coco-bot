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
import { RegisterCommand } from "../../../types";
import {
  clearActiveFlow,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowData,
  updateFlowStatus,
} from "../../../db";

export async function continueAfterBridge(
  handler: BotHandler,
  event: OnInteractionEventType,
  bridgeForm: FormCase,
  userState: UserState,
) {
  const { userId, channelId } = event;

  const threadId = event.threadId || event.eventId;

  const flowResult = await getActiveFlow(userId, threadId);

  // Check if flow exists
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
  let regData = flow.data;

  if (!bridgeForm) {
    return;
  }

  for (const component of bridgeForm.components) {
    if (component.component.case === "button" && component.id === "cancel") {
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);

      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId,
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
          { threadId },
        );
        return;
      }

      // Re-check L1 balance
      const selectedWallet = regData.selectedWallet!;
      const l1Balance = await checkBalance(selectedWallet, CHAIN_IDS.MAINNET);
      const requiredAmount = regData.grandTotalWei;

      if (l1Balance.balance < requiredAmount) {
        await handler.sendMessage(
          channelId,
          `⏳ Your bridged ETH may not have arrived yet.\n\n` +
            `**Current L1 Balance:** ${formatEther(l1Balance.balance)} ETH\n` +
            `**Required:** ~${formatEther(requiredAmount)} ETH\n\n` +
            `Bridging can take 10-20 minutes. Please wait and try again.`,
          { threadId },
        );

        // Send another continue button
        await handler.sendInteractionRequest(
          channelId,
          {
            type: "form",
            id: `continue_after_bridge:${threadId}`,
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
          { threadId },
        );
        return;
      }

      // Balance is sufficient - proceed with commit
      await handler.sendMessage(
        channelId,
        `✅ **Balance Confirmed!**\n\n` +
          `L1 Balance: ${formatEther(l1Balance.balance)} ETH\n\n` +
          `Proceeding with registration...`,
        { threadId },
      );

      const command = partialCommand as RegisterCommand;
      const needsNewCommitment =
        !regData.names ||
        regData.names.length === 0 ||
        !regData.names[0]?.commitment ||
        regData.names[0]?.owner?.toLowerCase() !== selectedWallet.toLowerCase();

      if (needsNewCommitment) {
        const reason = !regData.names?.length
          ? "no names"
          : !regData.names[0]?.commitment
            ? "no commitment"
            : "owner mismatch";

        console.log(
          `continueAfterBridge: Need new commitment - reason: ${reason}`,
        );
        console.log(`  Current owner: ${regData.names?.[0]?.owner}`);
        console.log(`  Selected wallet: ${selectedWallet}`);

        try {
          const freshReg = await prepareRegistration({
            names: command.names,
            owner: selectedWallet,
            durationYears: command.duration || 1,
          });

          await updateFlowData(userId, threadId, {
            ...freshReg,
            selectedWallet,
          });
          await updateFlowStatus(userId, threadId, "step1_pending");

          // Update local reference
          regData = { ...regData, ...freshReg, selectedWallet };

          console.log(
            "continueAfterBridge: Registration prepared with correct owner:",
          );
          console.log(
            `  Commitment exists: ${regData.names[0]?.commitment ? "✅" : "❌"}`,
          );
          console.log(`  Owner: ${regData.names[0]?.owner}`);
        } catch (error) {
          console.error(
            "continueAfterBridge: Error preparing registration:",
            error,
          );
          await handler.sendMessage(
            channelId,
            "❌ Failed to prepare registration. Please try again.",
            { threadId },
          );
          return;
        }
      } else {
        console.log(
          "continueAfterBridge: Commitment valid, owner matches:",
          selectedWallet,
        );
      }

      // Now we should have valid commitment with correct owner
      const firstCommitment = regData.names[0];

      if (!firstCommitment || !firstCommitment.commitment) {
        console.error(
          "continueAfterBridge: Still no commitment after preparation:",
          regData,
        );
        await handler.sendMessage(
          channelId,
          "❌ Failed to generate commitment. Please start again.",
          { threadId },
        );
        return;
      }

      // Final validation: ensure commitment owner matches selected wallet
      if (
        firstCommitment.owner?.toLowerCase() !== selectedWallet.toLowerCase()
      ) {
        console.error(
          "continueAfterBridge: Owner still mismatched after preparation!",
        );
        console.error(`  Commitment owner: ${firstCommitment.owner}`);
        console.error(`  Selected wallet: ${selectedWallet}`);
        await handler.sendMessage(
          channelId,
          "❌ Registration error: wallet mismatch. Please start again.",
          { threadId },
        );
        return;
      }

      const commitData = encodeCommitData(firstCommitment.commitment);
      const commitmentId = `commit:${userId}:${Date.now()}`;

      await updateFlowStatus(userId, threadId, "step1_pending");

      console.log("continueAfterBridge: Sending commit transaction");
      console.log(`  Domain: ${firstCommitment.name}`);
      console.log(`  Owner: ${firstCommitment.owner}`);
      console.log(`  Signer wallet: ${selectedWallet}`);

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
            signerWallet: selectedWallet,
          },
          recipient: userId as `0x${string}`,
        },
        {
          threadId,
        },
      );
      return;
    }
  }
}
