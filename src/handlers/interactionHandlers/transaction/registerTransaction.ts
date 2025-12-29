import { BotHandler } from "@towns-protocol/bot";
import { OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { clearBridge } from "../../../db/bridgeStore";

export async function registerTransaction(
  handler: BotHandler,
  event: OnInteractionEventType,
  tx: {
    requestId: string;
    txHash: string;
  },
  userState: UserState,
) {
  const { userId, eventId, channelId, threadId } = event;
  const registration = await getPendingRegistration(userId);
  const validThreadId = threadId ?? userState?.activeThreadId ?? eventId;

  if (!registration.success || !registration.data) {
    await handler.sendMessage(
      channelId,
      "Something went wrong retrieving your registration data.",
      { threadId },
    );
    return;
  }

  // TODO: Multiple names fix?
  const regData = registration.data;
  const registeredName = regData.names[0].name;

  if (tx.txHash) {
    // Registration complete!
    await handler.sendMessage(
      channelId,
      `🎉 **Congratulations!**

**${registeredName}** is now yours!

📝 **Transaction Details**
└─ Tx: ${tx.txHash}

**What's Next?**
- Set up your ENS records (address, avatar, social links)
- Use \`/set ${registeredName}\` to configure your name
- Visit [app.ens.domains](https://app.ens.domains) to manage your name

Welcome to ENS! 🚀`,
      { threadId },
    );

    // Clean up
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    await clearBridge(userId, validThreadId);
  } else {
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

    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    await clearBridge(userId, validThreadId);
  }

  return;
}
