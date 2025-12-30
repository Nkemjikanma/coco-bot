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
import { prepareRegistration } from "../../../services/ens"; // ✅ ADD THIS IMPORT

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

          // ✅ FIX: Prepare fresh registration with the CORRECT owner (selected wallet)
          console.log(
            "walletSelection: Preparing registration with correct owner:",
            walletAddress,
          );

          try {
            const freshRegistration = await prepareRegistration({
              names: command.names,
              owner: walletAddress, // ✅ Use the selected wallet!
              durationYears: command.duration,
            });

            // Update registration with FULL prepared data including commitment
            await updatePendingRegistration(userId, {
              ...freshRegistration,
              selectedWallet: walletAddress,
            });

            console.log(
              "walletSelection: Registration prepared with owner:",
              freshRegistration.names[0]?.owner,
            );

            // Update pending command state
            await setUserPendingCommand(
              userId,
              validThreadId,
              channelId,
              command,
              "bridge_confirmation",
            );

            // Pass the fresh registration to handleBridging
            await handleBridging(
              handler,
              selectedWalletInfo.address,
              channelId,
              validThreadId,
              userId,
              {
                ...registration.data,
                ...freshRegistration,
                selectedWallet: walletAddress,
              },
              command,
            );

            console.log("walletSelect: ‼️ We are done handling bridging");
            return;
          } catch (error) {
            console.error(
              "walletSelection: Error preparing registration:",
              error,
            );
            await handler.sendMessage(
              channelId,
              "❌ Failed to prepare registration. Please try again.",
              { threadId: validThreadId },
            );
            return;
          }
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
