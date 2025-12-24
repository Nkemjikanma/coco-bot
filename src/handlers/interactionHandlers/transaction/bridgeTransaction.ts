import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import { getPendingRegistration, UserState } from "../../../db/userStateStore";
import { getBridgeState, updateBridgeState } from "../../../db";
import { RegisterCommand } from "../../../types";
import { hexToBytes } from "viem";

export async function bridgeTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {
  const { userId, channelId, threadId, eventId } = event;

  const pendingRegistration = await getPendingRegistration(userId);
  const validThreadId =
    threadId?.toString() ?? userState?.activeThreadId ?? eventId;

  if (tx.requestId !== `bridge:${userId}${validThreadId}`) {
    await handler.sendMessage(
      channelId,
      "Couldn't reach the correct bridge. Something is wrong",
      { threadId: validThreadId },
    );
    return;
  }

  const bridgeState = await getBridgeState(userId, validThreadId);
  if (!bridgeState.success) {
    await handler.sendMessage(
      channelId,
      "Couldn't retrieve bridge state. Something went wrong.",
      { threadId: validThreadId },
    );
    return;
  }

  // Check transaction status
  if (!!tx.txHash) {
    await updateBridgeState(userId, validThreadId, {
      ...bridgeState.data,
      status: "failed",
    });
    await handler.sendMessage(
      channelId,
      "❌ Bridging failed. Please try again or bridge manually.",
      { threadId: validThreadId },
    );
    return;
  }

  // Bridge successful
  await updateBridgeState(userId, validThreadId, {
    ...bridgeState.data,
    status: "completed",
  });

  await handler.sendMessage(
    channelId,
    `✅ **Bridge Successful!**

Your ETH has been bridged to Ethereum Mainnet.

⏳ Please note: Bridging can take 10-20 minutes to finalize on L1. Once confirmed, we'll continue with your registration.`,
    { threadId: validThreadId },
  );

  // Check if we have pending registration
  if (!pendingRegistration.success || !pendingRegistration.data) {
    await handler.sendMessage(
      channelId,
      "Registration data expired. Please start again with `/register`",
      { threadId: validThreadId },
    );
    return;
  }

  // Check if we have the pending command
  if (!userState?.pendingCommand?.partialCommand) {
    await handler.sendMessage(
      channelId,
      "Lost track of your registration. Please start again with `/register`",
      { threadId: validThreadId },
    );
    return;
  }

  // Reconstruct the command from pending state
  const partialCommand = userState.pendingCommand.partialCommand;

  if (
    partialCommand.action !== "register" ||
    !partialCommand.names ||
    !partialCommand.duration
  ) {
    await handler.sendMessage(
      channelId,
      "Something went wrong with the registration data. Please start again.",
      { threadId: validThreadId },
    );
    return;
  }

  const command: RegisterCommand = {
    action: "register",
    names: partialCommand.names,
    duration: partialCommand.duration,
  };

  // Prompt user to continue
  await handler.sendInteractionRequest(
    channelId,
    {
      case: "form",
      value: {
        id: `continue_after_bridge:${validThreadId}`,
        title: "Continue Registration",
        components: [
          {
            id: "continue",
            component: {
              case: "button",
              value: { label: "✅ Continue Registration" },
            },
          },
          {
            id: "cancel",
            component: {
              case: "button",
              value: { label: "❌ Cancel" },
            },
          },
        ],
      },
    },
    hexToBytes(userId as `0x${string}`),
  );

  return;
}
