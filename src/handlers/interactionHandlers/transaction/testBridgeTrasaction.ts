// import { BotHandler } from "@towns-protocol/bot";
// import { OnInteractionEventType } from "../types";
// import {
//   clearPendingRegistration,
//   clearUserPendingCommand,
//   getPendingRegistration,
//   UserState,
// } from "../../../db/userStateStore";
// import { getBridgeState, updateBridgeState } from "../../../db";
// import { clearBridge } from "../../../db/bridgeStore";
// import { CHAIN_IDS } from "../../../services/bridge";
// import { checkBalance } from "../../../utils";
// import {
//   extractDepositId,
//   pollBridgeStatus,
// } from "../../../services/bridge/bridge";
// import { PendingRegistration } from "../../../types";
// import { formatEther, hexToBytes } from "viem";

// export async function testBridgeTransaction(
//   handler: BotHandler,
//   event: OnInteractionEventType,
//   tx: {
//     requestId: string;
//     txHash: string;
//   },
// ) {
//   const { userId, eventId, threadId, channelId } = event;

//   const validThreadId = event.threadId ?? eventId;

//   // Validate this is the correct bridge request
//   const expectedRequestId = `test_bridge:${userId}`;
//   console.log(tx.requestId);
//   console.log(tx.txHash);
//   console.log(expectedRequestId);
//   if (tx.requestId !== expectedRequestId) {
//     await handler.sendMessage(
//       channelId,
//       "⚠️ Received unexpected bridge response. Please try again.",
//       { threadId },
//     );
//     return;
//   }

//   const bridgeState = await getBridgeState(userId, validThreadId);

//   if (!bridgeState.success || !bridgeState.data) {
//     await handler.sendMessage(
//       channelId,
//       "❌ Bridge state not found. Please start again.",
//       { threadId },
//     );
//     return;
//   }

//   // Handle transaction rejection
//   if (!tx.txHash) {
//     await updateBridgeState(userId, validThreadId, {
//       ...bridgeState.data,
//       status: "failed",
//     });

//     await handler.sendMessage(
//       channelId,
//       "❌ Bridge transaction was rejected.",
//       { threadId },
//     );

//     await clearBridge(userId, validThreadId);
//     await clearPendingRegistration(userId);
//     await clearUserPendingCommand(userId);
//     return;
//   }

//   // Handle successful transaction submission
//   if (tx.txHash) {
//     const txHash = tx.txHash as `0x${string}`;

//     await handler.sendMessage(
//       channelId,
//       `✅ **Bridge transaction submitted!**\n\n` +
//         `Tx: ${txHash}\n\n` +
//         `⏳ Waiting for confirmation and bridge completion...\n` +
//         `This usually takes 1-2 minutes.`,
//       { threadId },
//     );

//     // Update bridge state with tx hash
//     await updateBridgeState(userId, validThreadId, {
//       ...bridgeState.data,
//       status: "bridging",
//       depositTxHash: txHash,
//     });

//     // Extract deposit ID from the transaction
//     const depositId = await extractDepositId(txHash, CHAIN_IDS.BASE);

//     if (!depositId) {
//       await handler.sendMessage(
//         channelId,
//         `⚠️ Couldn't extract deposit ID. Waiting for bridge anyway...\n\n` +
//           `If the bridge doesn't complete in 5 minutes, check your Mainnet balance manually.`,
//         { threadId },
//       );

//       // Fall back to balance polling
//       await pollForBalanceIncrease(
//         handler,
//         channelId,
//         validThreadId,
//         userId,
//         bridgeState.data.recipient,
//         bridgeState.data.amount,
//       );
//       return;
//     }

//     // Update with deposit ID
//     await updateBridgeState(userId, validThreadId, {
//       ...bridgeState.data,
//       status: "bridging",
//       depositTxHash: txHash,
//       depositId,
//     });

//     // Poll for bridge completion
//     pollBridgeStatus(
//       depositId,
//       async (status) => {
//         if (status.status === "filled") {
//           // Bridge completed!
//           await updateBridgeState(userId, validThreadId, {
//             ...bridgeState.data,
//             status: "completed",
//             depositTxHash: txHash,
//             depositId,
//             fillTxHash: status.fillTx,
//           });

//           await handler.sendMessage(
//             channelId,
//             `🎉 **Bridge Complete!**\n\n` +
//               `Your ETH has arrived on Ethereum Mainnet.\n` +
//               (status.fillTx ? `Fill Tx: ${status.fillTx}\n\n` : "\n") +
//               `Checking your balance...`,
//             { threadId },
//           );

//           // Check if this was a test bridge or a registration bridge
//           const pendingRegistration = await getPendingRegistration(userId);

//           if (!pendingRegistration.success || !pendingRegistration.data) {
//             // This was a test bridge, just show balance
//             const newBalance = await checkBalance(
//               bridgeState.data.recipient,
//               CHAIN_IDS.MAINNET,
//             );

//             await handler.sendMessage(
//               channelId,
//               `💰 **Mainnet Balance:** ${newBalance.balanceEth} ETH\n\n` +
//                 `Bridge test complete! ✅`,
//               { threadId },
//             );

//             await clearBridge(userId, validThreadId);
//             return;
//           }

//           // This is a registration bridge - continue with registration
//           await handlePostBridgeRegistration(
//             handler,
//             channelId,
//             validThreadId,
//             userId,
//             pendingRegistration.data,
//           );
//         } else if (status.status === "expired") {
//           // Bridge expired/failed
//           await updateBridgeState(userId, validThreadId, {
//             ...bridgeState.data,
//             status: "failed",
//           });

//           await handler.sendMessage(
//             channelId,
//             `❌ **Bridge Failed**\n\n` +
//               `The bridge request expired. Your funds should still be on Base.\n` +
//               `Please check your Base wallet and try again.`,
//             { threadId },
//           );

//           await clearBridge(userId, validThreadId);
//           await clearPendingRegistration(userId);
//           await clearUserPendingCommand(userId);
//         } else {
//           // Still pending after max wait time
//           await handler.sendMessage(
//             channelId,
//             `⏳ **Bridge Still Processing**\n\n` +
//               `The bridge is taking longer than expected.\n` +
//               `Please check your Mainnet balance in a few minutes.\n\n` +
//               `Once you have funds on Mainnet, type "continue registration" to proceed.`,
//             { threadId },
//           );
//         }
//       },
//       5 * 60 * 1000, // 5 minute max wait
//     );

//     return;
//   }

//   return;
// }

// /**
//  * Handle registration after bridge completes
//  */
// async function handlePostBridgeRegistration(
//   handler: BotHandler,
//   channelId: string,
//   threadId: string,
//   userId: string,
//   registration: PendingRegistration,
// ) {
//   // Verify balance on Mainnet
//   const mainnetBalance = await checkBalance(
//     registration.names[0].owner,
//     CHAIN_IDS.MAINNET,
//     registration.grandTotalWei,
//   );

//   if (!mainnetBalance.sufficient) {
//     await handler.sendMessage(
//       channelId,
//       `⚠️ **Balance Check**\n\n` +
//         `Your Mainnet balance: ${mainnetBalance.balanceEth} ETH\n` +
//         `Required: ${registration.grandTotalEth} ETH\n\n` +
//         `The bridged funds may still be arriving. Please wait a moment and try again.`,
//       { threadId },
//     );

//     // Send a retry button
//     await handler.sendInteractionRequest(
//       channelId,
//       {
//         case: "form",
//         value: {
//           id: `continue_after_bridge:${threadId}`,
//           title: "Continue Registration",
//           components: [
//             {
//               id: "continue",
//               component: {
//                 case: "button",
//                 value: { label: "🔄 Check Balance & Continue" },
//               },
//             },
//             {
//               id: "cancel",
//               component: {
//                 case: "button",
//                 value: { label: "❌ Cancel" },
//               },
//             },
//           ],
//         },
//       },
//       hexToBytes(userId as `0x${string}`),
//     );
//     return;
//   }
//   // Balance is sufficient - proceed with commit
//   await handler.sendMessage(
//     channelId,
//     `✅ **Balance Confirmed!**\n\n` +
//       `Mainnet Balance: ${mainnetBalance.balanceEth} ETH\n\n` +
//       `Ready to register **${registration.names[0].name}**!`,
//     { threadId },
//   );

//   // Send commit confirmation
//   await handler.sendInteractionRequest(
//     channelId,
//     {
//       case: "form",
//       value: {
//         id: `confirm_commit:${threadId}`,
//         title: "Confirm Registration: Step 1 of 2",
//         components: [
//           {
//             id: "confirm",
//             component: {
//               case: "button",
//               value: { label: "✅ Start Registration" },
//             },
//           },
//           {
//             id: "cancel",
//             component: {
//               case: "button",
//               value: { label: "❌ Cancel" },
//             },
//           },
//         ],
//       },
//     },
//     hexToBytes(userId as `0x${string}`),
//   );
// }

// /**
//  * Fallback: Poll for balance increase on Mainnet
//  * Used when we can't extract the deposit ID
//  */
// async function pollForBalanceIncrease(
//   handler: BotHandler,
//   channelId: string,
//   threadId: string,
//   userId: string,
//   address: `0x${string}`,
//   expectedIncrease: bigint,
// ) {
//   const initialBalance = await checkBalance(address, CHAIN_IDS.MAINNET);
//   const targetBalance = initialBalance.balance + expectedIncrease;

//   const maxWaitMs = 5 * 60 * 1000; // 5 minutes
//   const pollIntervalMs = 10 * 1000; // 10 seconds
//   const startTime = Date.now();

//   const poll = async () => {
//     try {
//       const currentBalance = await checkBalance(address, CHAIN_IDS.MAINNET);

//       // Check if balance increased significantly (at least 80% of expected)
//       const threshold = (expectedIncrease * 80n) / 100n;
//       const balanceIncrease = currentBalance.balance - initialBalance.balance;

//       if (balanceIncrease >= threshold) {
//         // Bridge likely completed
//         await handler.sendMessage(
//           channelId,
//           `🎉 **Funds Detected on Mainnet!**\n\n` +
//             `New Balance: ${currentBalance.balanceEth} ETH\n` +
//             `Increase: +${formatEther(balanceIncrease)} ETH`,
//           { threadId },
//         );

//         // Continue with registration if applicable
//         const pendingRegistration = await getPendingRegistration(userId);

//         if (pendingRegistration.success && pendingRegistration.data) {
//           await handlePostBridgeRegistration(
//             handler,
//             channelId,
//             threadId,
//             userId,
//             pendingRegistration.data,
//           );
//         } else {
//           // Test bridge complete
//           await handler.sendMessage(channelId, `Bridge test complete! ✅`, {
//             threadId,
//           });
//           await clearBridge(userId, threadId);
//         }

//         return;
//       }

//       // Continue polling if within time limit
//       if (Date.now() - startTime < maxWaitMs) {
//         setTimeout(poll, pollIntervalMs);
//       } else {
//         // Timeout
//         await handler.sendMessage(
//           channelId,
//           `⏳ **Bridge Timeout**\n\n` +
//             `We couldn't detect the bridged funds within 5 minutes.\n` +
//             `Your current Mainnet balance: ${currentBalance.balanceEth} ETH\n\n` +
//             `The bridge may still be processing. Please check again later and type "continue registration" when ready.`,
//           { threadId },
//         );
//       }
//     } catch (error) {
//       console.error("Error polling balance:", error);
//       if (Date.now() - startTime < maxWaitMs) {
//         setTimeout(poll, pollIntervalMs);
//       }
//     }
//   };

//   // Start polling
//   poll();
// }
