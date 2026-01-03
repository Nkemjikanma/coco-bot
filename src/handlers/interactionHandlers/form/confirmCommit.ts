import { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowStatus,
} from "../../../db";
import { encodeCommitData } from "../../../services/ens";
import { ENS_CONTRACTS, REGISTRATION } from "../../../services/ens/constants";
import { FormCase, OnInteractionEventType } from "../types";

export async function confirmCommit(
  handler: BotHandler,
  event: OnInteractionEventType,
  confirmForm: FormCase,
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
  const regData = flow.data;

  // Validate we have required data
  if (!regData || !regData.name || !regData.commitment) {
    await handler.sendMessage(
      channelId,
      "Registration expired. Please start again.",
      { threadId },
    );
    await clearActiveFlow(userId, threadId);
    return;
  }

  if (!confirmForm) {
    return;
  }

  for (const component of confirmForm.components) {
    // Handle cancel
    if (component.component.case === "button" && component.id === "cancel") {
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId,
      });
      return;
    }

    if (component.id === "confirm") {
      // Update status
      await updateFlowStatus(userId, threadId, "step1_pending");

      await handler.sendMessage(
        channelId,
        "🚀 Starting registration process...\n\nExecuting commit transaction...",
        { threadId },
      );

      const { commitment, selectedWallet, name } = regData;

      // Validate owner matches signer
      if (commitment.owner !== selectedWallet) {
        console.error("Owner/signer mismatch detected", {
          owner: commitment.owner,
          signer: selectedWallet,
        });

        await handler.sendMessage(
          channelId,
          "Internal error: Wallet mismatch detected. Please start registration again",
          { threadId },
        );

        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);
        return;
      }

      const commitData = encodeCommitData(commitment.commitment);

      // Generate a unique ID for transaction
      const commitmentId = `commit:${userId}:${Date.now()}`;

      // Send transaction interaction request
      await handler.sendInteractionRequest(
        channelId,
        {
          type: "transaction",
          id: commitmentId,
          title: `Commit ENS Registration: ${name}`,
          tx: {
            chainId: REGISTRATION.CHAIN_ID.toString(),
            to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
            value: "0",
            data: commitData,
            signerWallet: selectedWallet || undefined,
          },
          recipient: userId as `0x${string}`,
        },
        { threadId },
      );

      return;
    }
  }
}
