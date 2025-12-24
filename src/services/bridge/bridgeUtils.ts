import { formatEther, parseEther, hexToBytes } from "viem";
import { BotHandler } from "@towns-protocol/bot";
import {
  ParsedCommand,
  PendingRegistration,
  RegisterCommand,
} from "../../types";
import { CHAIN_IDS } from "./bridgeConstants";
import { getBridgeQuote } from "./bridge";
import { checkBalance } from "../../utils";
import { sendBotMessage } from "../../handlers";
import { BalanceCheckResult } from "./types";
import { prepareBridgeTransaction } from "./bridge";
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

  // Step 1: Get initial quote to estimate fees
  const initialQuote = await getBridgeQuote(
    registration.grandTotalWei,
    CHAIN_IDS.BASE,
    CHAIN_IDS.MAINNET,
  );

  if (initialQuote.isAmountTooLow) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ Amount too low for bridging. Minimum: ${formatEther(BigInt(initialQuote.limits.minDeposit))} ETH`,
    );
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Step 2: Calculate actual amount to bridge (desired output + fees)
  const bridgeFeeWei = BigInt(initialQuote.totalRelayFee.total);
  const amountToBridge = registration.grandTotalWei + bridgeFeeWei;

  // The output after fees should equal grandTotalWei
  const expectedOutput = registration.grandTotalWei;

  // Step 3: Estimate gas needed on Base for bridge transaction
  const baseGasEstimate = parseEther("0.001"); // Slightly higher estimate
  const totalNeededOnBase = amountToBridge + baseGasEstimate;

  // Step 4: Check if user has enough on Base
  if (baseBalanceCheck.balance < totalNeededOnBase) {
    const shortfall = totalNeededOnBase - baseBalanceCheck.balance;
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Insufficient funds on Base**\n\n` +
        `**Required on Base:**\n` +
        `• Amount to bridge: ${formatEther(amountToBridge)} ETH\n` +
        `• Bridge fee (included): ${formatEther(bridgeFeeWei)} ETH\n` +
        `• Gas for bridge tx: ~${formatEther(baseGasEstimate)} ETH\n` +
        `• **Total needed:** ${formatEther(totalNeededOnBase)} ETH\n\n` +
        `**Your Base balance:** ${baseBalanceCheck.balanceEth} ETH\n` +
        `**Shortfall:** ${formatEther(shortfall)} ETH`,
    );
    await clearPendingRegistration(userId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Step 5: Show bridge details and prepare transaction
  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `💡 **Bridge Required**\n\n` +
      `**Registration needs:** ${registration.grandTotalEth} ETH on Mainnet\n\n` +
      `**Bridge Details:**\n` +
      `• Sending: ${formatEther(amountToBridge)} ETH from Base\n` +
      `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
      `• You'll receive: ~${formatEther(expectedOutput)} ETH on Mainnet\n` +
      `• Estimated time: ~${initialQuote.estimatedFillTimeSec} seconds\n\n` +
      `⚠️ **Note:** The domain might be taken during bridging.\n\n` +
      `Approve the bridge transaction to continue...`,
  );

  // Step 6: Prepare bridge transaction with correct amount
  const bridgeData = prepareBridgeTransaction(
    amountToBridge,
    userTownsWallet,
    expectedOutput,
    CHAIN_IDS.BASE,
    CHAIN_IDS.MAINNET,
  );

  // Step 7: Store bridge state
  await setBridgeState(userId, threadId, {
    userId,
    channelId,
    domain: command.names[0],
    label: command.names[0].replace(".eth", ""),
    years: command.duration,
    fromChain: CHAIN_IDS.BASE,
    toChain: CHAIN_IDS.MAINNET,
    amount: amountToBridge,
    recipient: userTownsWallet,
    timestamp: Date.now(),
    status: "pending",
  });

  // Step 8: Send bridge transaction request
  await handler.sendInteractionRequest(
    channelId,
    {
      case: "transaction",
      value: {
        id: `bridge:${userId}:${threadId}`,
        title: `Bridge ${formatEther(amountToBridge)} ETH to Mainnet`,
        content: {
          case: "evm",
          value: {
            chainId: CHAIN_IDS.BASE.toString(),
            to: bridgeData.to,
            value: bridgeData.value,
            data: bridgeData.data,
          },
        },
      },
    },
    hexToBytes(userId as `0x${string}`),
  );

  return;
}
