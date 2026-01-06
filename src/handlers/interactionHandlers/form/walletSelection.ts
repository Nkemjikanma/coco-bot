import type { BotHandler } from "@towns-protocol/bot";
import { formatEther } from "viem";
import {
  clearActiveFlow,
  getActiveFlow,
  isRegistrationFlow,
  updateFlowData,
} from "../../../db";
import {
  clearUserPendingCommand,
  getUserState,
  setUserPendingCommand,
} from "../../../db/userStateStore";
import { handleBridging } from "../../../services/bridge/bridgeUtils";
import { prepareRegistration } from "../../../services/ens";
import type { RegisterCommand } from "../../../types";
import { formatAddress } from "../../../utils";
import { proceedWithRegistration } from "../../handleRegisterCommand";
import type { FormCase, OnInteractionEventType } from "../types";

export async function walletSelection(
  handler: BotHandler,
  event: OnInteractionEventType,
  walletForm: FormCase,
) {
  const { userId, channelId } = event;
  const threadId = event.threadId || event.eventId;

  if (!walletForm) {
    return;
  }

  for (const component of walletForm.components) {
    if (component.component.case === "button") {
      if (component.id === "cancel") {
        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);
        await handler.sendMessage(channelId, "Registration cancelled. 👋", {
          threadId,
        });
        return;
      }

      if (component.id.startsWith("wallet_")) {
        const walletAddress = component.id.split(":")[1] as `0x${string}`;

        const flowResult = await getActiveFlow(userId, threadId);
        const currentUserState = await getUserState(userId);

        if (!flowResult.success) {
          await handler.sendMessage(
            channelId,
            "Registration data expired. Please start again.",
            { threadId },
          );
          return;
        }

        if (!currentUserState?.pendingCommand?.partialCommand) {
          await handler.sendMessage(
            channelId,
            "Session expired. Please start again.",
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

        const command = currentUserState.pendingCommand
          .partialCommand as RegisterCommand;
        const walletCheck = regData.walletCheckResult;
        const requiredAmount = regData.grandTotalWei;

        // Find the selected wallet's info
        const selectedWalletInfo = walletCheck?.wallets.find(
          (w) => w.address.toLowerCase() === walletAddress.toLowerCase(),
        );

        if (!selectedWalletInfo) {
          await handler.sendMessage(
            channelId,
            "Wallet not found. Please try again.",
            { threadId },
          );
          return;
        }

        // Check if L1 has enough
        if (selectedWalletInfo.l1Balance >= requiredAmount) {
          await handler.sendMessage(
            channelId,
            `✅ Selected wallet: ${formatAddress(walletAddress)}`,
            { threadId },
          );

          await proceedWithRegistration(
            handler,
            channelId,
            threadId,
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
            { threadId },
          );

          console.log(
            "walletSelection: Preparing registration with correct owner:",
            walletAddress,
          );

          try {
            const freshRegistration = await prepareRegistration({
              name: command.name,
              owner: walletAddress,
              durationYears: command.duration,
            });

            // Update flow with fresh registration data
            await updateFlowData(userId, threadId, {
              name: freshRegistration.name,
              commitment: freshRegistration.commitment,
              costs: freshRegistration.costs,
              totalDomainCostWei: freshRegistration.totalDomainCostWei,
              totalDomainCostEth: freshRegistration.totalDomainCostEth,
              grandTotalWei: freshRegistration.grandTotalWei,
              grandTotalEth: freshRegistration.grandTotalEth,
              selectedWallet: walletAddress,
            });

            console.log(
              "walletSelection: Registration prepared with owner:",
              freshRegistration.commitment?.owner,
            );

            await setUserPendingCommand(
              userId,
              threadId,
              channelId,
              command,
              "bridge_confirmation",
            );

            await handleBridging(
              handler,
              selectedWalletInfo.address,
              channelId,
              threadId,
              userId,
              {
                ...regData,
                name: regData.name,
                commitment: freshRegistration.commitment,
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
              { threadId },
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
          { threadId },
        );

        return;
      }
    }
  }
}
