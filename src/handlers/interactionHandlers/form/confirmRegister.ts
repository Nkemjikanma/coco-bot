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
  // registration: RegistrationResult<PendingRegistration>,
) {
  const { userId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);

  const validThreadId =
    event.threadId ?? userState.activeThreadId ?? event.eventId;

  if (!registration.success || !registration.data) {
    await handler.sendMessage(
      channelId,
      "Registration expired. Please start again.",
      { threadId },
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
        threadId,
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
          case: "transaction",
          value: {
            id: registerId,
            title: `Register: ${firstReg.name}`,
            content: {
              case: "evm",
              value: {
                chainId: REGISTRATION.CHAIN_ID,
                to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                value: firstReg.domainPriceWei.toString(),
                data: registerData,
                signerWallet: undefined,
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
