// import { formatEther, parseEther, hexToBytes } from "viem";
// import type { BotHandler } from "@towns-protocol/bot";
// import { getBridgeQuoteAndTx } from "./bridge";
// import { checkBalance } from "./bridge";
// import { CHAIN_IDS } from "./bridgeConstants";

// export async function testBridge(
//   handler: BotHandler,
//   channelId: string,
//   threadId: string,
//   userId: string,
//   userWallet: `0x${string}`,
//   amountEth: string, // e.g., "0.01"
// ) {
//   try {
//     const amountToBridge = parseEther(amountEth);

//     // Step 1: Check Base balance
//     await handler.sendMessage(channelId, `🔍 Checking your Base balance...`, {
//       threadId,
//     });

//     const baseBalance = await checkBalance(userWallet, CHAIN_IDS.BASE);

//     if (baseBalance.balance < amountToBridge) {
//       await handler.sendMessage(
//         channelId,
//         `❌ Insufficient Base balance.\n\n` +
//           `• You have: ${baseBalance.balanceEth} ETH\n` +
//           `• You need: ${amountEth} ETH`,
//         { threadId },
//       );
//       return;
//     }

//     // Step 2: Get bridge quote
//     await handler.sendMessage(channelId, `📊 Getting bridge quote...`, {
//       threadId,
//     });

//     const { quote, swapTx } = await getBridgeQuoteAndTx(
//       amountToBridge,
//       userWallet,
//       CHAIN_IDS.BASE,
//       CHAIN_IDS.MAINNET,
//     );

//     const bridgeFeeWei = BigInt(quote.totalRelayFee.total);
//     const outputAmount = amountToBridge - bridgeFeeWei;

//     await handler.sendMessage(
//       channelId,
//       `💡 **Bridge Quote**\n\n` +
//         `• Amount to send: ${amountEth} ETH\n` +
//         `• Bridge fee: ${formatEther(bridgeFeeWei)} ETH (${quote.totalRelayFee.pct}%)\n` +
//         `• You'll receive: ${formatEther(outputAmount)} ETH on Mainnet\n` +
//         `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
//         `Preparing transaction...`,
//       { threadId },
//     );

//     // Step 4: Store bridge state for tracking
//     await setBridgeState(userId, threadId, {
//       userId,
//       channelId,
//       domain: "test-bridge",
//       label: "test-bridge",
//       years: 0,
//       fromChain: CHAIN_IDS.BASE,
//       toChain: CHAIN_IDS.MAINNET,
//       amount: amountToBridge,
//       recipient: userWallet,
//       timestamp: Date.now(),
//       status: "pending",
//     });

//     // Step 5: Send transaction request
//     await handler.sendInteractionRequest(channelId, {
//       type: "transaction",
//       id: `test_bridge:${userId}`,
//       title: `Test Bridge: ${amountEth} ETH to Mainnet`,
//       tx: {
//         chainId: CHAIN_IDS.BASE.toString(),
//         to: swapTx.to,
//         value: swapTx.value,
//         data: swapTx.data,
//         signerWallet: userWallet,
//       },
//       recipient: userId as `0x${string}`,
//     });

//     await handler.sendMessage(
//       channelId,
//       `✅ Bridge transaction sent!\n\nPlease approve in your wallet.`,
//       { threadId },
//     );
//   } catch (error) {
//     console.error("Test bridge error:", error);
//     await handler.sendMessage(
//       channelId,
//       `❌ Bridge test failed: ${error instanceof Error ? error.message : "Unknown error"}`,
//       { threadId },
//     );
//   }
// }
