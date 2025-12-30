import { formatEther, parseEther, hexToBytes } from "viem";
import { BotHandler } from "@towns-protocol/bot";
import { PendingRegistration, RegisterCommand } from "../../types";
import { CHAIN_IDS } from "./bridgeConstants";
import { getBridgeQuoteAndTx } from "./bridge";
import { checkBalance } from "../../utils";
import { sendBotMessage } from "../../handlers";
import {
  setBridgeState,
  clearPendingRegistration,
  clearUserPendingCommand,
  updatePendingRegistration,
} from "../../db";
import { clearBridge } from "../../db/bridgeStore";
import { prepareRegistration } from "../../services/ens"; // ✅ ADD THIS IMPORT

export async function handleBridging(
  handler: BotHandler,
  userWallet: `0x${string}`,
  channelId: string,
  threadId: string,
  userId: string,
  registration: PendingRegistration,
  command: RegisterCommand,
) {
  const baseBalanceCheck = await checkBalance(userWallet, CHAIN_IDS.BASE);

  await sendBotMessage(
    handler,
    channelId,
    threadId,
    userId,
    `Getting bridge quote...`,
  );

  try {
    // ✅ FIX: Prepare registration with commitment BEFORE bridging
    // This ensures we have the commitment data for after the bridge completes
    if (
      !registration.names ||
      registration.names.length === 0 ||
      !registration.names[0]?.commitment
    ) {
      console.log(
        "handleBridging: No commitment found, preparing registration...",
      );

      try {
        const preparedReg = await prepareRegistration({
          names: command.names,
          owner: userWallet,
          durationYears: command.duration,
        });

        // Update the stored registration with the prepared data (including commitment)
        await updatePendingRegistration(userId, {
          ...preparedReg,
          selectedWallet: userWallet,
        });

        // Update local reference
        registration = {
          ...registration,
          ...preparedReg,
          selectedWallet: userWallet,
        };

        console.log(
          "handleBridging: Registration prepared with commitment:",
          registration.names[0]?.commitment ? "✅ exists" : "❌ missing",
        );
      } catch (prepError) {
        console.error(
          "handleBridging: Error preparing registration:",
          prepError,
        );
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          `❌ Failed to prepare registration. Please try again.`,
        );
        await clearPendingRegistration(userId);
        await clearUserPendingCommand(userId);
        return;
      }
    }

    // First, get a quote to understand the fee structure
    const initialQuote = await getBridgeQuoteAndTx(
      registration.grandTotalWei,
      userWallet,
      CHAIN_IDS.BASE,
      CHAIN_IDS.MAINNET,
    );

    // Calculate the fee percentage from the initial quote
    const initialInput = registration.grandTotalWei;
    const initialOutput = BigInt(initialQuote.quote.outputAmount || "0");
    const feeAmount = initialInput - initialOutput;

    // Calculate amount to bridge: we need output >= grandTotalWei
    const feeWithBuffer = (feeAmount * 110n) / 100n;
    const amountToBridge = registration.grandTotalWei + feeWithBuffer;

    // Now get the actual quote with the correct input amount
    const { quote, swapTx } = await getBridgeQuoteAndTx(
      amountToBridge,
      userWallet,
      CHAIN_IDS.BASE,
      CHAIN_IDS.MAINNET,
    );

    if (quote.isAmountTooLow) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ Amount too low for bridging. Minimum: ${formatEther(BigInt(quote.limits.minDeposit))} ETH \n\n`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await clearBridge(userId, threadId);
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
          `Please fund your Mainnet wallet directly or wait for lower fees.\n\n`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await clearBridge(userId, threadId);
      return;
    }

    // Estimate gas needed on Base for bridge transaction
    const baseGasEstimate = parseEther("0.001");
    const totalNeededOnBase = amountToBridge + baseGasEstimate;

    if (baseBalanceCheck.balance < totalNeededOnBase) {
      const shortfall = totalNeededOnBase - baseBalanceCheck.balance;
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Insufficient funds on Base**\n\n` +
          `**Required on Base:**\n\n` +
          `• Amount to bridge: ${formatEther(amountToBridge)} ETH\n\n` +
          `• Gas for bridge tx: ~${formatEther(baseGasEstimate)} ETH\n\n` +
          `• **Total needed:** ${formatEther(totalNeededOnBase)} ETH\n\n` +
          `**Your Base balance:** ${baseBalanceCheck.balanceEth} ETH\n\n` +
          `**Shortfall:** ${formatEther(shortfall)} ETH \n\n`,
      );
      await clearPendingRegistration(userId);
      await clearUserPendingCommand(userId);
      await clearBridge(userId, threadId);
      return;
    }

    // Show bridge details
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `🌉 **Bridge Required**\n\n` +
        `**Registration needs:** ${registration.grandTotalEth} ETH on Mainnet\n\n` +
        `**Bridge Details:**\n` +
        `• Sending: ${formatEther(amountToBridge)} ETH from Base\n\n` +
        `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n\n` +
        `• You'll receive: ~${formatEther(outputAmount)} ETH (native) on Mainnet\n\n` +
        `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
        `⚠️ **Note:** The domain might be taken during bridging.\n\n` +
        `Approve the bridge transaction to continue... \n\n`,
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
      amount: amountToBridge,
      recipient: userWallet,
      timestamp: Date.now(),
      status: "pending",
    });

    // Send bridge transaction request
    await handler.sendInteractionRequest(
      channelId,
      {
        type: "transaction",
        id: `bridge:${userId}:${threadId}`,
        title: `Bridge ${formatEther(amountToBridge)} ETH to Mainnet`,
        tx: {
          chainId: CHAIN_IDS.BASE.toString(),
          to: swapTx.to,
          data: swapTx.data,
          value: swapTx.value,
          signerWallet: userWallet || undefined,
        },
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );

    console.log("handleBridging: ‼️ We are done handling bridging");

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
    await clearBridge(userId, threadId);
    return;
  }
}
