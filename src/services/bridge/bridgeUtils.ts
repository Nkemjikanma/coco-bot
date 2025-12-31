import { formatEther, parseEther } from "viem";
import { BotHandler } from "@towns-protocol/bot";
import { PendingRegistration, RegisterCommand } from "../../types";
import { CHAIN_IDS } from "./bridgeConstants";
import { getBridgeQuoteAndTx } from "./bridge";
import { checkBalance } from "../../utils";
import { sendBotMessage } from "../../handlers";
import {
  clearActiveFlow,
  clearUserPendingCommand,
  updateFlowData,
  updateFlowStatus,
} from "../../db";
import { prepareRegistration } from "../../services/ens";

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
    // Check BOTH that commitment exists AND owner matches selected wallet
    const needsNewCommitment =
      !registration.names ||
      registration.names.length === 0 ||
      !registration.names[0]?.commitment ||
      registration.names[0]?.owner?.toLowerCase() !== userWallet.toLowerCase();

    if (needsNewCommitment) {
      const reason = !registration.names?.length
        ? "no names"
        : !registration.names[0]?.commitment
          ? "no commitment"
          : "owner mismatch";

      console.log(`handleBridging: Need new commitment - reason: ${reason}`);
      console.log(`  Current owner: ${registration.names?.[0]?.owner}`);
      console.log(`  Selected wallet: ${userWallet}`);

      try {
        const preparedReg = await prepareRegistration({
          names: command.names,
          owner: userWallet,
          durationYears: command.duration,
        });

        // ✅ Update the flow data
        await updateFlowData(userId, threadId, {
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
          "handleBridging: Registration prepared with correct owner:",
        );
        console.log(
          `  Commitment exists: ${registration.names[0]?.commitment ? "✅" : "❌"}`,
        );
        console.log(`  Owner: ${registration.names[0]?.owner}`);
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
        await clearActiveFlow(userId, threadId);
        await clearUserPendingCommand(userId);
        return;
      }
    } else {
      console.log(
        "handleBridging: Commitment valid, owner matches:",
        userWallet,
      );
    }

    // Get initial quote to understand fee structure
    const initialQuote = await getBridgeQuoteAndTx(
      registration.grandTotalWei,
      userWallet,
      CHAIN_IDS.BASE,
      CHAIN_IDS.MAINNET,
    );

    // Calculate fee percentage from initial quote
    const initialInput = registration.grandTotalWei;
    const initialOutput = BigInt(initialQuote.quote.outputAmount || "0");
    const feeAmount = initialInput - initialOutput;

    // Calculate amount to bridge: we need output >= grandTotalWei
    const feeWithBuffer = (feeAmount * 110n) / 100n;
    const amountToBridge = registration.grandTotalWei + feeWithBuffer;

    // Get actual quote with correct input amount
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
      // ✅ Only need clearActiveFlow - no separate clearBridge
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
      return;
    }

    const bridgeFeeWei = BigInt(quote.totalRelayFee.total);
    const outputAmount = BigInt(quote.outputAmount || "0");

    // Validate output amount covers registration cost
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
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
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
      // ✅ Only need clearActiveFlow - handles everything
      await clearActiveFlow(userId, threadId);
      await clearUserPendingCommand(userId);
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

    // ✅ Update flow status to awaiting bridge
    await updateFlowStatus(userId, threadId, "awaiting_bridge");

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
    // ✅ Only need clearActiveFlow - no separate clearBridge
    await clearActiveFlow(userId, threadId);
    await clearUserPendingCommand(userId);
    return;
  }
}
