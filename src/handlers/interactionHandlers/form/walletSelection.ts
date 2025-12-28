import { BotHandler } from "@towns-protocol/bot";
import { FormCase, OnInteractionEventType } from "../types";
import {
  clearPendingRegistration,
  clearUserPendingCommand,
  getPendingRegistration,
  getUserState,
  setUserPendingCommand,
  updatePendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { RegisterCommand } from "../../../types";
import { formatAddress } from "../../../utils";
import { proceedWithRegistration } from "../../handle_message";
import { formatEther } from "viem";
import { handleBridging } from "../../../services/bridge/bridgeUtils";

export async function walletSelection(
  handler: BotHandler,
  event: OnInteractionEventType,
  walletForm: FormCase,
  userState: UserState,
) {
  const { userId, channelId, threadId, eventId } = event;

  const validThreadId = threadId ?? userState.activeThreadId ?? eventId;

  if (!walletForm) {
    return;
  }

  for (const component of walletForm.components) {
    if (component.component.case === "button") {
      if (component.id === "cancel") {
        await clearPendingRegistration(userId);
        await clearUserPendingCommand(userId);
        await handler.sendMessage(channelId, "Registration cancelled. 👋", {
          threadId: validThreadId,
        });
        return;
      }

      if (component.id.startsWith("wallet_")) {
        const walletAddress = component.id.split(":")[1] as `0x${string}`;

        const registration = await getPendingRegistration(userId);
        const userState = await getUserState(userId);

        if (!registration.success || !registration.data) {
          await handler.sendMessage(
            channelId,
            "Registration data expired. Please start again.",
            { threadId: validThreadId },
          );
          return;
        }

        if (!userState?.pendingCommand?.partialCommand) {
          await handler.sendMessage(
            channelId,
            "Session expired. Please start again.",
            { threadId: validThreadId },
          );
          return;
        }

        const command = userState.pendingCommand
          .partialCommand as RegisterCommand;
        const walletCheck = registration.data.walletCheckResult;
        const requiredAmount = registration.data.grandTotalWei;

        // Find the selected wallet's info
        const selectedWalletInfo = walletCheck?.wallets.find(
          (w) => w.address.toLowerCase() === walletAddress.toLowerCase(),
        );

        if (!selectedWalletInfo) {
          await handler.sendMessage(
            channelId,
            "Wallet not found. Please try again.",
            { threadId: validThreadId },
          );
          return;
        }

        // Check if L1 has enough
        if (selectedWalletInfo.l1Balance >= requiredAmount) {
          // Proceed with registration
          await handler.sendMessage(
            channelId,
            `✅ Selected wallet: ${formatAddress(walletAddress)}`,
            { threadId: validThreadId },
          );

          await proceedWithRegistration(
            handler,
            channelId,
            validThreadId,
            userId,
            command,
            walletAddress,
            walletCheck!,
          );
          return;
        }

        // Check if L2 has enough to bridge
        const bridgeBuffer = (requiredAmount * 105n) / 100n;
        if (selectedWalletInfo.l2Balance >= bridgeBuffer) {
          await handler.sendMessage(
            channelId,
            `🌉 Selected wallet: ${formatAddress(walletAddress)}\n\n` +
              `This wallet needs to bridge ETH from Base to Mainnet.`,
            { threadId: validThreadId },
          );

          // Update registration with selected wallet
          await updatePendingRegistration(userId, {
            selectedWallet: walletAddress,
          });

          // Update pending command state
          await setUserPendingCommand(
            userId,
            validThreadId,
            channelId,
            command,
            "bridge_confirmation",
          );

          // confirm bridge transaction request
          await handleBridging(
            handler,
            selectedWalletInfo.address,
            channelId,
            validThreadId,
            userId,
            registration.data,
            command,
          );
          return;
        }

        // Neither L1 nor L2 has enough
        await handler.sendMessage(
          channelId,
          `❌ **Insufficient Balance**\n\n` +
            `**${formatAddress(walletAddress)}**\n` +
            `• Mainnet: ${Number(selectedWalletInfo.l1BalanceEth).toFixed(4)} ETH\n` +
            `• Base: ${Number(selectedWalletInfo.l2BalanceEth).toFixed(4)} ETH\n\n` +
            `**Required:** ~${formatEther(requiredAmount)} ETH\n\n` +
            `Please select a different wallet or fund this one.`,
          { threadId: validThreadId },
        );

        return;
      }
    }
  }
}
