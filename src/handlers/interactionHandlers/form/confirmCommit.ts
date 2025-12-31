import { BotHandler } from "@towns-protocol/bot";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowStatus,
  updateFlowData,
} from "../../../db";
import { encodeCommitData } from "../../../services/ens";
import { ENS_CONTRACTS, REGISTRATION } from "../../../services/ens/constants";
import { FormCase, OnInteractionEventType } from "../types";
import { UserState } from "../../../db/userStateStore";

export async function confirmCommit(
  handler: BotHandler,
  event: OnInteractionEventType,
  confirmForm: FormCase,
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
  const regData = flow.data;

  if (!regData || !regData.names || regData.names.length === 0) {
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
      // ✅ Use new API for cleanup
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId,
      });
      return;
    }

    if (component.id === "confirm") {
      // ✅ Update status using new API
      await updateFlowStatus(userId, threadId, "step1_pending");

      await handler.sendMessage(
        channelId,
        "🚀 Starting registration process...\n\nExecuting commit transaction...",
        { threadId },
      );

      // TODO: Handle multiple names
      const firstCommitment = regData.names[0];

      // Validate owner matches signer
      if (firstCommitment.owner !== regData.selectedWallet) {
        console.error("Owner/signer mismatch detected", {
          owner: firstCommitment.owner,
          signer: regData.selectedWallet,
        });

        await handler.sendMessage(
          channelId,
          "Internal error: Wallet mismatch detected. Please start registration again",
          { threadId },
        );

        // ✅ Use new API for cleanup
        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);
        return;
      }

      const commitData = encodeCommitData(firstCommitment.commitment);

      // Generate a unique ID for transaction
      const commitmentId = `commit:${userId}:${Date.now()}`;

      // Send transaction interaction request
      await handler.sendInteractionRequest(
        channelId,
        {
          type: "transaction",
          id: commitmentId,
          title: `Commit ENS Registration: ${firstCommitment.name}`,
          tx: {
            chainId: REGISTRATION.CHAIN_ID.toString(),
            to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
            value: "0",
            data: commitData,
            signerWallet: regData.selectedWallet || undefined,
          },
          recipient: userId as `0x${string}`,
        },
        { threadId },
      );

      return;
    }
  }
}
