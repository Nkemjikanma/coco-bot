import { BotHandler } from "@towns-protocol/bot";
import { FormCase, OnInteractionEventType } from "../types";
import { encodeRegisterData } from "../../../services/ens";
import { ENS_CONTRACTS, REGISTRATION } from "../../../services/ens/constants";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowStatus,
} from "../../../db";

export async function confirmRegister(
  handler: BotHandler,
  event: OnInteractionEventType,
  registerForm: FormCase,
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

  if (!registerForm) {
    return;
  }

  for (const component of registerForm.components) {
    if (component.component.case === "button" && component.id === "cancel") {
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId,
      });
      return;
    }

    if (component.component.case === "button" && component.id === "confirm") {
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

      // Update status
      await updateFlowStatus(userId, threadId, "step2_pending");

      // Encode register function call
      const registerData = encodeRegisterData({
        name: name.replace(/\.eth$/, ""),
        owner: commitment.owner,
        duration: commitment.durationSec,
        secret: commitment.secret,
        resolver: ENS_CONTRACTS.PUBLIC_RESOLVER,
        data: [],
        reverseRecord: false,
        ownerControlledFuses: 0,
      });

      const registerId = `register:${userId}:${Date.now()}`;

      await handler.sendInteractionRequest(
        channelId,
        {
          type: "transaction",
          id: registerId,
          title: `Register: ${name}`,
          tx: {
            chainId: REGISTRATION.CHAIN_ID,
            to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
            value: commitment.domainPriceWei.toString(),
            data: registerData,
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
