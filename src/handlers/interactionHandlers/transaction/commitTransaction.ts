import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import { UserState } from "../../../db/userStateStore";

export async function commitTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {}
