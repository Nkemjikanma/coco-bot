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

  const validThreadId =
    event.threadId ?? userState.activeThreadId ?? event.eventId;

  if (!registration.success) {
    await handler.sendMessage(
      channelId,
      `Something went wrong: ${registration.error}. Please start again.`,
      { threadId: validThreadId },
    );
    await clearUserPendingCommand(userId);
    return;
  }

  if (!registration.data) {
    await handler.sendMessage(
      channelId,
      "Registration expired. Please start again.",
      { threadId: validThreadId },
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
      { threadId: validThreadId },
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

      const commitData = encodeCommitData(firstCommitment.commitment);

      // Generate a unique ID for transaction
      const commitmentId = `commit:${userId}:${Date.now()}`;

      // Send transaction interaction request
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
                chainId: REGISTRATION.CHAIN_ID, // Mainnet
                to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                value: "0",
                data: commitData,
                // signerWallet: undefined,
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
