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

export async function confirmRegister(
  handler: BotHandler,
  event: OnInteractionEventType,
  registerForm: FormCase,
  userState: UserState,
  userTownWallet: `0x${string}` | null,
) {
  const { userId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);

  const validThreadId = userState.activeThreadId ?? threadId ?? channelId;

  if (!registration.success || !registration.data) {
    await handler.sendMessage(
      channelId,
      "Registration expired. Please start again.",
      { threadId: validThreadId || undefined },
    );
    return;
  }

  if (!registerForm) {
    return;
  }

  for (const component of registerForm.components) {
    if (component.component.case === "button" && component.id === "cancel") {
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId: validThreadId || undefined,
      });
      return;
    }

    if (component.component.case === "button" && component.id === "confirm") {
      const regData = registration.data;
      const firstReg = regData.names[0];

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
