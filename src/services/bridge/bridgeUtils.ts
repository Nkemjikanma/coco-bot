import { formatEther, parseEther, hexToBytes } from "viem";
import { BotHandler } from "@towns-protocol/bot";
import {
  ParsedCommand,
  PendingRegistration,
  RegisterCommand,
} from "../../types";
import { CHAIN_IDS } from "./bridgeConstants";
import { getBridgeQuoteAndTx } from "./bridge"; // Use new function
import { checkBalance } from "../../utils";
import { sendBotMessage } from "../../handlers";
import { BalanceCheckResult } from "./types";
import {
  setBridgeState,
  getBridgeState,
  clearPendingRegistration,
  clearUserPendingCommand,
} from "../../db";

export async function handleBridging(
  handler: BotHandler,
  userTownsWallet: `0x${string}`,
  channelId: string,
  threadId: string,
  userId: string,
  mainnetBalance: BalanceCheckResult,
  registration: PendingRegistration,
  command: RegisterCommand,
) {
  const baseBalanceCheck = await checkBalance(userTownsWallet, CHAIN_IDS.BASE);

  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `Getting bridge quote...`,
  );

  try {
    // Use the new Swap API function that returns native ETH
    const { quote, swapTx } = await getBridgeQuoteAndTx(
      registration.grandTotalWei,
      userTownsWallet,
      CHAIN_IDS.BASE,
      CHAIN_IDS.MAINNET,
    );

    if (quote.isAmountTooLow) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ Amount too low for bridging. Minimum: ${formatEther(BigInt(quote.limits.minDeposit))} ETH`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      return;
    }

    const bridgeFeeWei = BigInt(quote.totalRelayFee.total);
    const outputAmount = BigInt(quote.outputAmount || "0");

    // Validate that output amount covers registration cost
    if (outputAmount < registration.grandTotalWei) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Bridge fees too high**\n\n` +
          `After bridge fees of ${formatEther(bridgeFeeWei)} ETH, ` +
          `you would only receive ${formatEther(outputAmount)} ETH on Mainnet.\n\n` +
          `This is not enough to cover the registration cost of ${registration.grandTotalEth} ETH.\n\n` +
          `Please fund your Mainnet wallet directly or wait for lower fees.`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      return;
    }

    // Estimate gas needed on Base for bridge transaction
    const baseGasEstimate = parseEther("0.001");
    const totalNeededOnBase = registration.grandTotalWei + baseGasEstimate;

    if (baseBalanceCheck.balance < totalNeededOnBase) {
      const shortfall = totalNeededOnBase - baseBalanceCheck.balance;
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Insufficient funds on Base**\n\n` +
          `**Required on Base:**\n` +
          `• Amount to bridge: ${formatEther(registration.grandTotalWei)} ETH\n` +
          `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
          `• Gas for bridge tx: ~${formatEther(baseGasEstimate)} ETH\n` +
          `• **Total needed:** ${formatEther(totalNeededOnBase)} ETH\n\n` +
          `**Your Base balance:** ${baseBalanceCheck.balanceEth} ETH\n` +
          `**Shortfall:** ${formatEther(shortfall)} ETH`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      return;
    }

    // Show bridge details
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `💡 **Bridge Required**\n\n` +
        `**Registration needs:** ${registration.grandTotalEth} ETH on Mainnet\n\n` +
        `**Bridge Details:**\n` +
        `• Sending: ${formatEther(registration.grandTotalWei)} ETH from Base\n` +
        `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
        `• You'll receive: ~${formatEther(outputAmount)} ETH (native) on Mainnet\n` +
        `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
        `⚠️ **Note:** The domain might be taken during bridging.\n\n` +
        `Approve the bridge transaction to continue...`,
    );

    // Store bridge state
    await setBridgeState(userId, threadId, {
      userId,
      channelId,
      domain: command.names[0],
      label: command.names[0].replace(".eth", ""),
      years: command.duration,
      fromChain: CHAIN_IDS.BASE,
      toChain: CHAIN_IDS.MAINNET,
      amount: registration.grandTotalWei,
      recipient: userTownsWallet,
      timestamp: Date.now(),
      status: "pending",
    });

    // Send bridge transaction request using the Swap API response
    await handler.sendInteractionRequest(
      channelId,
      {
        case: "transaction",
        value: {
          id: `bridge:${userId}:${threadId}`,
          title: `Bridge ${formatEther(registration.grandTotalWei)} ETH to Mainnet`,
          content: {
            case: "evm",
            value: {
              chainId: CHAIN_IDS.BASE.toString(),
              to: swapTx.to,
              value: swapTx.value,
              data: swapTx.data,
            },
          },
        },
      },
      hexToBytes(userId as `0x${string}`),
    );

    return;
  } catch (error) {
    console.error("Bridge error:", error);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ Failed to get bridge quote. Please try again later.`,
    );
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    return;
  }
}
