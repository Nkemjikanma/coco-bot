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
  command: RegisterCommand, // how can I make this agnostic
) {
  const baseBalanceCheck = await checkBalance(userTownsWallet, CHAIN_IDS.BASE);

  // Get bridge quote first to calculate total needed including fees
  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `Getting bridge quote...`,
  );

  const bridgeQuote = await getBridgeQuote(
    registration.grandTotalWei,
    CHAIN_IDS.BASE,
    CHAIN_IDS.MAINNET,
  );

  const baseBalanceMessage = baseBalanceCheck.sufficient
    ? `✅ Your BASE balance: ${formatEther(BigInt(bridgeQuote.limits.minDeposit))} ETH (sufficient)`
    : `⚠️ Your BASE balance: ${formatEther(BigInt(bridgeQuote.limits.minDeposit))} ETH\n\n
    `;

  if (bridgeQuote.isAmountTooLow) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `🛑 **Balance Check** \n

              ${baseBalanceMessage}\n

              ⚠️ You don't have enough ETH to cover transaction.`,
    );
    return;
  }

  // Calculate output amount after bridge fees
  const bridgeFeeWei = BigInt(bridgeQuote.totalRelayFee.total);
  const outputAmount =
    registration.grandTotalWei > bridgeFeeWei
      ? registration.grandTotalWei - bridgeFeeWei
      : 0n;

  // Validate that output amount covers registration cost
  if (outputAmount < registration.totalDomainCostWei) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Bridge fees too high**\n\n` +
        `After bridge fees of ${formatEther(bridgeFeeWei)} ETH, ` +
        `you would only receive ${formatEther(
          outputAmount,
        )} ETH on Mainnet.\n\n` +
        `This is not enough to cover the registration cost of ${registration.grandTotalEth} ETH.\n\n` +
        `Please fund your Mainnet wallet directly or wait for lower fees.`,
    );

    clearPendingRegistration(userId);
    clearUserPendingCommand(userId);

    return;
  }

  // Estimate gas needed on Base for bridge transaction (rough estimate)
  const baseGasEstimate = parseEther("0.0005");
  const totalNeededOnBase =
    registration.totalDomainCostWei + bridgeFeeWei + baseGasEstimate;

  if (baseBalanceCheck.balance < totalNeededOnBase) {
    // User doesn't have enough on Base to cover bridge + fees + gas
    const shortfall = totalNeededOnBase - baseBalanceCheck.balance;
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Insufficient funds**\n\n` +
        `You need ${formatEther(
          registration.totalDomainCostWei,
        )} ETH on Ethereum Mainnet to register ${registration.names[0]}.\n\n` +
        `**To bridge from Base, you need:**\n` +
        `• Bridge amount: ${formatEther(registration.totalDomainCostWei)} ETH\n` +
        `• Bridge fee: ${formatEther(bridgeFeeWei)} ETH (${
          bridgeQuote.totalRelayFee.pct
        }%)\n` +
        `• Gas on Base: ~${formatEther(baseGasEstimate)} ETH\n` +
        `• **Total needed on Base:** ${formatEther(
          totalNeededOnBase,
        )} ETH\n\n` +
        `**Your balances:**\n` +
        `• Mainnet: ${mainnetBalance.balanceEth} ETH\n` +
        `• Base: ${baseBalanceCheck.balanceEth} ETH\n\n` +
        `You need ${formatEther(
          shortfall,
        )} more ETH on Base to complete the bridge.`,
    );

    clearPendingRegistration(userId);
    clearUserPendingCommand(userId);
    return;
  }

  // User has enough on Base, show bridge details
  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `💡 **Bridge Required**\n\n` +
      `**Registration Details:**\n` +
      `• Domain: ${registration.names[0]}\n` +
      `• Registration cost: ${registration.grandTotalEth} ETH\n` +
      `• Total needed (incl. gas): ${formatEther(
        registration.totalDomainCostWei,
      )} ETH\n\n` +
      `**Bridge Details:**\n` +
      `• From: Base (${baseBalanceCheck.balanceEth} ETH available)\n` +
      `• To: Ethereum Mainnet\n` +
      `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH (${
        bridgeQuote.totalRelayFee.pct
      }%)\n` +
      `• You'll receive: ~${formatEther(outputAmount)} ETH on Mainnet\n` +
      `• Estimated time: ~${bridgeQuote.estimatedFillTimeSec} seconds\n\n` +
      `⚠️ **Note:** The domain might be taken during bridging if it's popular.\n\n` +
      `Preparing bridge transaction...`,
  );

  const bridgeData = prepareBridgeTransaction(
    registration.totalDomainCostWei,
    userTownsWallet, // what wallet is this?
    outputAmount,
    CHAIN_IDS.BASE,
    CHAIN_IDS.MAINNET,
  );

  // store bridge state
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

  const bridge = await getBridgeState(userId, threadId);

  if (!bridge.success) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "Error fetching bridge state",
    );
    return;
  }

  // Send bridge transaction request
  await handler.sendInteractionRequest(
    channelId,
    {
      case: "transaction",
      value: {
        id: `bridge:${userId}${threadId}`,
        title: `Bridge ${formatEther(registration.grandTotalWei)} ETH to Mainnet`,
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

  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `📤 **Bridge transaction sent!**\n\n` +
      `Please approve the bridge transaction in your wallet.\n` +
      `Once confirmed, I'll automatically proceed with ENS registration.`,
  );

  return;
}
