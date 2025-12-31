import { BotHandler } from "@towns-protocol/bot";
import { FormCase, OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { encodeRegisterData } from "../../../services/ens";
import { ENS_CONTRACTS, REGISTRATION } from "../../../services/ens/constants";
import { hexToBytes } from "viem";
import { PendingRegistration, RegistrationResult } from "../../../types";
import {
  clearActiveFlow,
  getActiveFlow,
  isRegistrationFlow,
} from "../../../db";

export async function confirmRegister(
  handler: BotHandler,
  event: OnInteractionEventType,
  registerForm: FormCase,
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
      const firstReg = regData.names[0];

      // validate owner matches signer - safety
      if (firstReg.owner !== regData.selectedWallet) {
        console.error("Owner/signer mismatch detected", {
          owner: firstReg.owner,
          signer: regData.selectedWallet,
        });

        await handler.sendMessage(
          channelId,
          "Internal error: Wallet mismatch detected. Please start registratioin again",
          { threadId },
        );

        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);

        return;
      }

      // Encode register function call
      const registerData = encodeRegisterData({
        name: firstReg.name.replace(/\.eth$/, ""),
        owner: firstReg.owner,
        duration: firstReg.durationSec,
        secret: firstReg.secret,
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
          title: `Register: ${firstReg.name}`,
          tx: {
            chainId: REGISTRATION.CHAIN_ID,
            to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
            value: firstReg.domainPriceWei.toString(),
            data: registerData,
            signerWallet: regData.selectedWallet || undefined,
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
