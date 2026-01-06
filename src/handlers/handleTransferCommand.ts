import type { BotHandler } from "@towns-protocol/bot";
import { isAddress } from "viem";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  getActiveFlow,
  setActiveFlow,
  setUserPendingCommand,
} from "../db";
import { createTransferFlow } from "../db/flow.utils";
import { getTransferService } from "../services/ens/transfer/transfer";
import { metrics } from "../services/metrics/metrics";
import type { TransferCommand } from "../types";
import { filterEOAs, formatAddress } from "../utils";
import { sendBotMessage } from "./handle_message_utils";

export async function handleTransferCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: TransferCommand,
) {
  const service = getTransferService();
  const { name, recipient } = command;

  await metrics.trackCommand("transfer", userId, { name });

  console.log(name, recipient);

  // Validation
  if (!recipient) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Missing transfer information**\n\n` +
        `Please specify the recipient address for the transfer.\n` +
        `Example: \`transfer alice.eth to 0x1234...5678\``,
    );
    return;
  }

  if (!name) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Missing transfer information**\n\n` +
        `Please specify the ENS name to transfer.\n` +
        `Example: \`transfer alice.eth to 0x1234...5678\``,
    );
    return;
  }

  try {
    // Get user's EOA wallets
    const userWallets = await filterEOAs(userId as `0x${string}`);

    if (userWallets.length === 0) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **No EOA wallets found**\n\n` +
          `You need an EOA wallet (like MetaMask) connected to transfer a name.\n` +
          `Please connect an external wallet and try again.`,
      );
      return;
    }

    console.log(`handleTransferCommand: Checking ownership of ${name}`);
    console.log(`handleTransferCommand: User wallets:`, userWallets);

    // Verify ownership (auto-detects wrapped vs unwrapped)
    const ownershipResult = await service.verifyParentOwnership(
      name,
      userWallets,
    );

    console.log(`handleTransferCommand: Ownership result:`, ownershipResult);

    if (!ownershipResult.owned) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Validation Failed**\n\n${ownershipResult.error}`,
      );
      return;
    }

    const ownerWallet = ownershipResult.ownerWallet!;
    const isWrapped = ownershipResult.isWrapped;

    // Determine which contract will be used
    const contract = service.getTransferContract(name, isWrapped);

    if (!isAddress(recipient)) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Something wrong**\n\n` +
          `recipient address might have malformed, let's try again `,
      );
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);

      return;
    }

    // Create transfer flow
    const transferFlow = createTransferFlow({
      userId,
      threadId,
      channelId,
      status: "awaiting_confirmation",
      data: {
        domain: name,
        recipient: recipient as `0x${string}`,
        ownerWallet: ownerWallet,
        isWrapped: isWrapped,
        contract: contract,
      },
    });

    await setActiveFlow(transferFlow);

    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      "transfer_confirmation",
    );

    const contractCheck = await service.checkSmartContractOnChains(
      recipient as `0x${string}`,
    );

    await metrics.trackEvent("transfer_started", {
      userId,
      name,
      recipient,
    });

    let confirmationMessage =
      `✅ **Transfer Validation Passed**\n\n` +
      `• **Name:** ${name}\n` +
      `• **From:** \`${formatAddress(ownerWallet)}\`\n` +
      `• **To:** \`${formatAddress(recipient as `0x${string}`)}\`\n` +
      `• **Type:** ${isWrapped ? "Wrapped (NameWrapper)" : "Unwrapped"}\n\n`;

    if (contractCheck.warning) {
      confirmationMessage += `${contractCheck.warning}\n\n`;
    }

    confirmationMessage +=
      `⚠️ **Warning:** This action is irreversible. The recipient will become the new owner of **${name}**.\n\n` +
      `💰 **Cost:** Gas only (~$2-5)`;

    // Show transfer summary
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      confirmationMessage,
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `transfer_confirm:${threadId}`,
        title: `Transfer ${name}`,
        components: [
          {
            id: "confirm",
            type: "button",
            label: "✅ Confirm Transfer",
          },
          {
            id: "cancel",
            type: "button",
            label: "❌ Cancel",
          },
        ],
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );
  } catch (error) {
    console.error("Error in transfer command:", error);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ An unexpected error occurred. Please try again later.`,
    );
  }
}
