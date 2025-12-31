import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import { clearUserPendingCommand, UserState } from "../../../db/userStateStore";
import {
  clearActiveFlow,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowStatus,
} from "../../../db";

export async function registerTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {
  const { userId, channelId } = event;
  const threadId = event.threadId || event.eventId;

  const flowResult = await getActiveFlow(userId, threadId);

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
  // TODO: Multiple names fix?
  const registeredName = regData.names[0].name;

  if (tx.txHash) {
    // ✅ Update status to complete
    await updateFlowStatus(userId, threadId, "complete");

    // Registration complete!
    await handler.sendMessage(
      channelId,
      `🎉 **Congratulations!**

**${registeredName}** is now yours!

🔗 **Transaction Details**
└─ Tx: ${tx.txHash}

**What's Next?**
- Set up your ENS records (address, avatar, social links)
- Use \`/set ${registeredName}\` to configure your name
- Visit [app.ens.domains](https://app.ens.domains) to manage your name

Welcome to ENS! 🚀`,
      { threadId },
    );

    // Clean up
    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
  } else {
    // ✅ Update status to failed
    await updateFlowStatus(userId, threadId, "failed");

    await handler.sendMessage(
      channelId,
      `❌ **Registration Failed**

The register transaction for **${registeredName}** failed.

This could happen if:
- The commit expired (must register within 24 hours of commit)
- Someone else registered the name first
- Insufficient funds

Would you like to try again? Use \`/register ${registeredName}\``,
      { threadId },
    );

    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
  }

  return;
}
