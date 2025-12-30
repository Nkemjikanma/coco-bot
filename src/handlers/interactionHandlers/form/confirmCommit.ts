import {
  BotHandler,
  DecryptedInteractionResponse,
  BasePayload,
} from "@towns-protocol/bot";
import { getPendingRegistration, getUserState } from "../../../db";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  updatePendingRegistration,
} from "../../../db";
import { encodeCommitData } from "../../../services/ens";
import { ENS_CONTRACTS, REGISTRATION } from "../../../services/ens/constants";
import { hexToBytes } from "viem";
import { FormCase, OnInteractionEventType } from "../types";
import { UserState } from "../../../db/userStateStore";

export async function confirmCommit(
  handler: BotHandler,
  event: OnInteractionEventType,
  confirmForm: FormCase,
  userState: UserState,
) {
  const { userId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);

  const validThreadId = userState.activeThreadId ?? threadId ?? channelId;

  if (!registration.success) {
    await handler.sendMessage(
      channelId,
      `Something went wrong: ${registration.error}. Please start again.`,
      { threadId: validThreadId || undefined },
    );
    await clearUserPendingCommand(userId);
    return;
  }

  if (!registration.data) {
    await handler.sendMessage(
      channelId,
      "Registration expired. Please start again.",
      { threadId: validThreadId || undefined },
    );
    return;
  }

  const updateResult = await updatePendingRegistration(userId, {
    phase: "commit_pending",
  });

  if (!updateResult.success) {
    await handler.sendMessage(
      channelId,
      "Failed to update registration. Please try again.",
      { threadId: validThreadId || undefined },
    );
    return;
  }

  if (!confirmForm) {
    return;
  }

  for (const component of confirmForm.components) {
    // Handle cancel
    if (component.component.case === "button" && component.id === "cancel") {
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId,
      });
      return;
    }

    if (component.id === "confirm") {
      // Update phase
      await updatePendingRegistration(userId, {
        phase: "commit_pending",
      });

      // Update phase
      await handler.sendMessage(
        channelId,
        "🚀 Starting registration process...\n\nExecuting commit transaction...",
        { threadId },
      );

      const regData = registration.data;

      // TODO!: for now, let's handle only one name
      const firstCommitment = regData.names[0];

      // validate owner matches signer - safety
      if (firstCommitment.owner !== regData.selectedWallet) {
        console.error("Owner/signer mismatch detected", {
          owner: firstCommitment.owner,
          signer: regData.selectedWallet,
        });

        await handler.sendMessage(
          channelId,
          "Internal error: Wallet mismatch detected. Please start registratioin again",
          { threadId: validThreadId },
        );

        await clearPendingRegistration(userId);
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
            chainId: REGISTRATION.CHAIN_ID.toString(), // Mainnet
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
