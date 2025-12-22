import { makeTownsBot, type BotHandler } from "@towns-protocol/bot";
import commands from "./commands";
import {
  clearUserPendingCommand,
  getUserState,
  sessionExists,
  getPendingRegistration,
  clearPendingRegistration,
  updatePendingRegistration,
  getBridgeState,
  updateBridgeState,
} from "./db";
import {
  executeValidCommand,
  handleOnMessage,
  handlePendingCommandResponse,
  handleSlashCommand,
} from "./handlers";

import { hexToBytes, formatEther } from "viem";
import { ENS_CONTRACTS, REGISTRATION } from "./services/ens/constants";

import type { ParsedCommand, PendingCommand, RegisterCommand } from "./types";
import { encodeCommitData, encodeRegisterData } from "./services/ens";
import { estimateRegisterGas } from "./services/ens/ens";
import { threadId } from "worker_threads";
import { checkBalance } from "./utils";
import { CHAIN_IDS } from "./services/bridge";

// import { handleInteractionResponse } from "./handlers";

const APP_DATA = process.env.APP_PRIVATE_DATA;
const SECRET = process.env.JWT_SECRET;

if (!APP_DATA || !SECRET) {
  throw new Error("Missing APP_DATA or SECRET information. Fix env");
}
export const bot = await makeTownsBot(APP_DATA, SECRET, {
  commands,
});

const cocoCommands = [
  "help",
  "check",
  "register",
  "renew",
  "transfer",
  "set",
  "subdomain",
  "portfolio",
  "expiry",
  "history",
  "remind",
  "watch",
] as const;

for (const command of cocoCommands) {
  bot.onSlashCommand(command, async (handler, event) => {
    await handleSlashCommand(handler, event);
  });
}

bot.onMessage(async (handler, event) => {
  // if message is from bot, ignore
  if (event.userId === bot.botId) return;

  const shouldRespond = await shouldRespondToMessage(event);

  if (shouldRespond) {
    if (
      event.message
        .trim()
        .split(" ")
        .filter((m) => m.toLowerCase() !== "@coco").length === 0
    ) {
      await handler.sendMessage(
        event.channelId,
        "You sent an empty messsage ser",
        {
          threadId: event.threadId || event.eventId,
        },
      );
    }

    await handleOnMessage(handler, event);
  }
});

bot.onInteractionResponse(async (handler, event) => {
  const { userId, response, channelId } = event;

  switch (response.payload.content.case) {
    case "form": {
      const form = response.payload.content.value;

      if (form.requestId.startsWith("confirm_commit")) {
        const userState = await getUserState(userId);
        if (!userState?.pendingCommand) {
          await handler.sendMessage(
            channelId,
            "Sorry, I lost track of what we were doing. Please start again.",
          );
          return;
        }

        const registration = await getPendingRegistration(userId);

        const threadId =
          event.threadId ?? userState.activeThreadId ?? event.eventId;

        if (!registration.success) {
          await handler.sendMessage(
            channelId,
            `Something went wrong: ${registration.error}. Please start again.`,
            { threadId },
          );
          await clearUserPendingCommand(userId);
          return;
        }

        if (!registration.data) {
          await handler.sendMessage(
            channelId,
            "Registration expired. Please start again.",
            { threadId },
          );
          return;
        }

        const updateResult = await updatePendingRegistration(userId, {
          phase: "commit_pending",
        });

        if (!updateResult.success) {
          await handler.sendMessage(
            channelId,
            "Failed to update registration. Please try again.",
            { threadId },
          );
          return;
        }

        for (const component of form.components) {
          // Handle cancel
          if (
            component.component.case === "button" &&
            component.id === "cancel"
          ) {
            await clearPendingRegistration(userId);
            await clearUserPendingCommand(userId);
            await handler.sendMessage(channelId, "Registration cancelled. 👋", {
              threadId,
            });
            return;
          }

          if (component.id === "confirm") {
            // Update phase
            await updatePendingRegistration(userId, {
              phase: "commit_pending",
            });

            // Update phase
            await handler.sendMessage(
              channelId,
              "🚀 Starting registration process...\n\nExecuting commit transaction...",
              { threadId },
            );

            const regData = registration.data;

            // TODO!: for now, let's handle only one name
            const firstCommitment = regData.names[0];

            const commitData = encodeCommitData(firstCommitment.commitment);

            // Generate a unique ID for transaction
            const commitmentId = `commit:${userId}:${Date.now()}`;

            // Send transaction interaction request
            await handler.sendInteractionRequest(
              channelId,
              {
                case: "transaction",
                value: {
                  id: commitmentId,
                  title: `Commit ENS Registration: ${firstCommitment.name}`,
                  content: {
                    case: "evm",
                    value: {
                      chainId: REGISTRATION.CHAIN_ID, // Mainnet
                      to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                      value: "0",
                      data: commitData,
                      // signerWallet: undefined,
                    },
                  },
                },
              },
              hexToBytes(userId as `0x${string}`),
            );

            return;
          }
        }
      }

      if (form.requestId.startsWith("duration_form")) {
        const userState = await getUserState(userId);

        if (!userState?.pendingCommand) {
          await handler.sendMessage(
            channelId,
            "Sorry, I lost track of what we were doing. Please start again.",
          );
          return;
        }

        const threadId =
          event.threadId ?? userState.activeThreadId ?? event.eventId;
        for (const component of form.components) {
          // Handle cancel
          if (
            component.component.case === "button" &&
            component.id === "cancel"
          ) {
            await clearUserPendingCommand(userId);
            await handler.sendMessage(channelId, "Registration cancelled. 👋", {
              threadId,
            });
            return;
          }

          // handle duration input
          if (
            component.component.case === "textInput" &&
            component.id === "duration_text_field"
          ) {
            const durationStr = component.component.value.value;
            const duration = parseInt(durationStr, 10);

            // Validate duration
            if (Number.isNaN(duration) || duration < 1 || duration > 10) {
              await handler.sendMessage(
                channelId,
                "Please enter a valid duration between 1 and 10 years.",
                { threadId },
              );
              return;
            }

            // Type guarding to get the RegisterCommand
            const partialCommand = userState.pendingCommand.partialCommand;

            // Ensure it's a register command
            if (partialCommand.action !== "register") {
              await handler.sendMessage(
                channelId,
                "Something went wrong. Please start again.",
                { threadId },
              );
              await clearUserPendingCommand(userId);
              return;
            }

            const updatedCommand: RegisterCommand = {
              action: "register",
              names: partialCommand.names ?? [],
              duration,
            };

            if (updatedCommand.names.length === 0) {
              await handler.sendMessage(
                channelId,
                "Something went wrong. Please start again.",
                { threadId },
              );
              await clearUserPendingCommand(userId);
              return;
            }

            // Clear pending state
            await clearUserPendingCommand(userId);
            await executeValidCommand(
              handler,
              channelId,
              threadId,
              userId,
              updatedCommand,
            );
            return;
          }
        }
      }

      if (form.requestId.startsWith("confirm_register")) {
        const userState = await getUserState(userId);
        const registration = await getPendingRegistration(userId);
        const threadId =
          event.threadId ?? userState?.activeThreadId ?? channelId;

        if (!registration.success || !registration.data) {
          await handler.sendMessage(
            channelId,
            "Registration expired. Please start again.",
            { threadId },
          );
          return;
        }

        for (const component of form.components) {
          if (
            component.component.case === "button" &&
            component.id === "cancel"
          ) {
            await clearPendingRegistration(userId);
            await clearUserPendingCommand(userId);
            await handler.sendMessage(channelId, "Registration cancelled. 👋", {
              threadId,
            });
            return;
          }

          if (
            component.component.case === "button" &&
            component.id === "confirm"
          ) {
            const regData = registration.data;
            const firstReg = regData.names[0];

            // Encode register function call
            const registerData = encodeRegisterData({
              name: firstReg.name.replace(/\.eth$/, ""),
              owner: firstReg.owner,
              duration: firstReg.durationSec,
              secret: firstReg.secret,
              resolver: ENS_CONTRACTS.PUBLIC_RESOLVER,
              data: [],
              reverseRecord: false,
              ownerControlledFuses: 0,
            });

            const registerId = `register:${userId}:${Date.now()}`;

            await handler.sendInteractionRequest(
              channelId,
              {
                case: "transaction",
                value: {
                  id: registerId,
                  title: `Register: ${firstReg.name}`,
                  content: {
                    case: "evm",
                    value: {
                      chainId: REGISTRATION.CHAIN_ID,
                      to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                      value: firstReg.domainPriceWei.toString(),
                      data: registerData,
                      signerWallet: undefined,
                    },
                  },
                },
              },
              hexToBytes(userId as `0x${string}`),
            );

            return;
          }
        }
      }

      if (form.requestId.startsWith("continue_after_bridge")) {
        const userState = await getUserState(userId);
        const pendingRegistration = await getPendingRegistration(userId);
        const validThreadId =
          event.threadId ?? userState?.activeThreadId ?? channelId;

        for (const component of form.components) {
          if (
            component.component.case === "button" &&
            component.id === "cancel"
          ) {
            await clearPendingRegistration(userId);
            await clearUserPendingCommand(userId);
            await handler.sendMessage(channelId, "Registration cancelled. 👋", {
              threadId: validThreadId,
            });
            return;
          }

          if (
            component.component.case === "button" &&
            component.id === "continue"
          ) {
            // Verify user now has enough L1 balance
            const partialCommand = userState?.pendingCommand?.partialCommand;

            if (!partialCommand || partialCommand.action !== "register") {
              await handler.sendMessage(
                channelId,
                "Lost track of your registration. Please start again.",
                { threadId: validThreadId },
              );
              return;
            }

            if (!pendingRegistration.success || !pendingRegistration.data) {
              await handler.sendMessage(
                channelId,
                "Registration data expired. Please start again.",
                { threadId: validThreadId },
              );
              return;
            }

            // Re-check L1 balance
            const owner = pendingRegistration.data.names[0].owner;
            const l1Balance = await checkBalance(owner, CHAIN_IDS.MAINNET);
            const requiredAmount = pendingRegistration.data.grandTotalWei;

            if (l1Balance.balance < requiredAmount) {
              await handler.sendMessage(
                channelId,
                `⏳ Your bridged ETH may not have arrived yet.

        **Current L1 Balance:** ${formatEther(l1Balance.balance)} ETH
        **Required:** ~${formatEther(requiredAmount)} ETH

        Bridging can take 10-20 minutes. Please wait and try again.`,
                { threadId: validThreadId },
              );

              // Send another continue button
              await handler.sendInteractionRequest(
                channelId,
                {
                  case: "form",
                  value: {
                    id: `continue_after_bridge:${validThreadId}`,
                    title: "Check Balance & Continue",
                    components: [
                      {
                        id: "continue",
                        component: {
                          case: "button",
                          value: { label: "🔄 Check Again & Continue" },
                        },
                      },
                      {
                        id: "cancel",
                        component: {
                          case: "button",
                          value: { label: "❌ Cancel" },
                        },
                      },
                    ],
                  },
                },
                hexToBytes(userId as `0x${string}`),
              );
              return;
            }

            // Balance is sufficient - proceed with commit
            await handler.sendMessage(
              channelId,
              `✅ **Balance Confirmed!**

        L1 Balance: ${formatEther(l1Balance.balance)} ETH

        Proceeding with registration...`,
              { threadId: validThreadId },
            );

            // Now send the commit transaction
            const regData = pendingRegistration.data;
            const firstCommitment = regData.names[0];
            const commitData = encodeCommitData(firstCommitment.commitment);
            const commitmentId = `commit:${userId}:${Date.now()}`;

            await updatePendingRegistration(userId, {
              phase: "commit_pending",
            });

            await handler.sendInteractionRequest(
              channelId,
              {
                case: "transaction",
                value: {
                  id: commitmentId,
                  title: `Commit ENS Registration: ${firstCommitment.name}`,
                  content: {
                    case: "evm",
                    value: {
                      chainId: "1",
                      to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
                      value: "0",
                      data: commitData,
                    },
                  },
                },
              },
              hexToBytes(userId as `0x${string}`),
            );

            return;
          }
        }
      }
      break;
    }
    case "transaction": {
      const tx = response.payload.content.value;
      const txHash = tx.txHash; // Transaction hash if successful
      const success = !!txHash; // Error message if failed

      // Check if this is a commit transaction
      if (tx.requestId.startsWith("commit:")) {
        const userState = await getUserState(userId);
        const threadId =
          event.threadId ?? userState?.activeThreadId ?? event.eventId;

        // Check transaction status
        if (tx.txHash) {
          // Update registration with tx hash and timestamp
          await updatePendingRegistration(userId, {
            phase: "awaiting_register_confirmation",
            commitTxHash: tx.txHash as `0x${string}`,
            commitTimestamp: Date.now(),
          });

          await handler.sendMessage(
            channelId,
            `✅ Commit transaction successful!\n\nTx: ${tx.txHash}\n\n⏳ Please wait ~60 seconds before we can complete the registration. I'll notify you when it's ready.`,
            { threadId },
          );

          // Start the wait timer
          startCommitWaitTimer(handler, channelId, threadId, userId);
        } else if (!tx.txHash) {
          await handler.sendMessage(
            channelId,
            "❌ Commit transaction failed. Please try again.",
            { threadId },
          );
          await clearPendingRegistration(userId);
          await clearUserPendingCommand(userId);
        }

        return;
      }

      if (tx.requestId.startsWith("bridge:")) {
        const userState = await getUserState(userId);
        const pendingRegistration = await getPendingRegistration(userId);
        const validThreadId =
          threadId?.toString() ?? userState?.activeThreadId ?? event;

        if (tx.requestId !== `bridge:${userId}${validThreadId}`) {
          await handler.sendMessage(
            channelId,
            "Couldn't reach the correct bridge. Something is wrong",
            { threadId: validThreadId },
          );
          return;
        }

        const bridgeState = await getBridgeState(userId, validThreadId);
        if (!bridgeState.success) {
          await handler.sendMessage(
            channelId,
            "Couldn't retrieve bridge state. Something went wrong.",
            { threadId: validThreadId },
          );
          return;
        }

        // Check transaction status
        if (!!tx.txHash) {
          await updateBridgeState(userId, validThreadId, {
            ...bridgeState.data,
            status: "failed",
          });
          await handler.sendMessage(
            channelId,
            "❌ Bridging failed. Please try again or bridge manually.",
            { threadId: validThreadId },
          );
          return;
        }

        // Bridge successful
        await updateBridgeState(userId, validThreadId, {
          ...bridgeState.data,
          status: "completed",
        });

        await handler.sendMessage(
          channelId,
          `✅ **Bridge Successful!**

      Your ETH has been bridged to Ethereum Mainnet.

      ⏳ Please note: Bridging can take 10-20 minutes to finalize on L1. Once confirmed, we'll continue with your registration.`,
          { threadId: validThreadId },
        );

        // Check if we have pending registration
        if (!pendingRegistration.success || !pendingRegistration.data) {
          await handler.sendMessage(
            channelId,
            "Registration data expired. Please start again with `/register`",
            { threadId: validThreadId },
          );
          return;
        }

        // Check if we have the pending command
        if (!userState?.pendingCommand?.partialCommand) {
          await handler.sendMessage(
            channelId,
            "Lost track of your registration. Please start again with `/register`",
            { threadId: validThreadId },
          );
          return;
        }

        // Reconstruct the command from pending state
        const partialCommand = userState.pendingCommand.partialCommand;

        if (
          partialCommand.action !== "register" ||
          !partialCommand.names ||
          !partialCommand.duration
        ) {
          await handler.sendMessage(
            channelId,
            "Something went wrong with the registration data. Please start again.",
            { threadId: validThreadId },
          );
          return;
        }

        const command: RegisterCommand = {
          action: "register",
          names: partialCommand.names,
          duration: partialCommand.duration,
        };

        // Option 2: Prompt user to continue
        await handler.sendInteractionRequest(
          channelId,
          {
            case: "form",
            value: {
              id: `continue_after_bridge:${validThreadId}`,
              title: "Continue Registration",
              components: [
                {
                  id: "continue",
                  component: {
                    case: "button",
                    value: { label: "✅ Continue Registration" },
                  },
                },
                {
                  id: "cancel",
                  component: {
                    case: "button",
                    value: { label: "❌ Cancel" },
                  },
                },
              ],
            },
          },
          hexToBytes(userId as `0x${string}`),
        );

        return;
      }

      // Handle register transaction
      if (tx.requestId.startsWith("register:")) {
        const userState = await getUserState(userId);
        const registration = await getPendingRegistration(userId);
        const threadId =
          event.threadId ?? userState?.activeThreadId ?? event.eventId;

        if (!registration.success || !registration.data) {
          await handler.sendMessage(
            channelId,
            "Something went wrong retrieving your registration data.",
            { threadId },
          );
          return;
        }

        const regData = registration.data;
        const registeredName = regData.names[0].name;

        if (tx.txHash) {
          // Registration complete!
          await handler.sendMessage(
            channelId,
            `🎉 **Congratulations!**

      **${registeredName}** is now yours!

      📝 **Transaction Details**
      └─ Tx: ${tx.txHash}

      **What's Next?**
      - Set up your ENS records (address, avatar, social links)
      - Use \`/set ${registeredName}\` to configure your name
      - Visit [app.ens.domains](https://app.ens.domains) to manage your name

      Welcome to ENS! 🚀`,
            { threadId },
          );

          // Clean up
          await clearPendingRegistration(userId);
          await clearUserPendingCommand(userId);
        } else {
          await handler.sendMessage(
            channelId,
            `❌ **Registration Failed**

      The register transaction for **${registeredName}** failed.

      This could happen if:
      - The commit expired (must register within 24 hours of commit)
      - Someone else registered the name first
      - Insufficient funds

      Would you like to try again? Use \`/register ${registeredName}\``,
            { threadId },
          );

          await clearPendingRegistration(userId);
          await clearUserPendingCommand(userId);
        }

        return;
      }
      break;
    }
  }
});

async function shouldRespondToMessage(event: {
  isMentioned: boolean;
  threadId: string | undefined;
  message: string;
}): Promise<boolean> {
  // Always respond if mentioned
  if (event.isMentioned) {
    return true;
  }

  // Respond if in an existing session thread
  if (event.threadId) {
    const hasSession = await sessionExists(event.threadId);
    if (hasSession) {
      return true;
    }
  }

  // Check for ENS-related keywords
  if (containsEnsKeywords(event.message)) {
    return true;
  }

  return false;
}

function containsEnsKeywords(message: string): boolean {
  const lowerMessage = message.toLowerCase();

  // ENS-specific keywords
  const ensKeywords = [
    ".eth",
    "ens",
    "register",
    "renew",
    "transfer",
    "domain",
    "check availability",
    "is available",
  ];

  // Bot name
  const botNames = ["coco"];

  const allKeywords = [...ensKeywords, ...botNames];

  return allKeywords.some((keyword) => lowerMessage.includes(keyword));
}

function startCommitWaitTimer(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
) {
  // Wait 65 seconds to be safe (ENS requires 60 seconds)
  const waitTime = 65 * 1000;

  setTimeout(async () => {
    try {
      const registration = await getPendingRegistration(userId);

      if (!registration.success || !registration.data) {
        // Registration was cancelled or expired
        return;
      }

      if (registration.data.phase !== "awaiting_register_confirmation") {
        // Not in the right phase
        return;
      }

      const commitment = registration.data.names[0];

      // Estimate register gas with actual values from stored commitment
      const gasEstimate = await estimateRegisterGas({
        account: commitment.owner,
        label: commitment.name.replace(/\.eth$/, ""), // Removing .eth suffix
        owner: commitment.owner,
        durationSec: commitment.durationSec,
        secret: commitment.secret,
        resolver: ENS_CONTRACTS.PUBLIC_RESOLVER,
        data: [],
        reverseRecord: false,
        ownerControlledFuses: 0,
        value: commitment.domainPriceWei,
      });

      // update registration
      await updatePendingRegistration(userId, {
        costs: {
          ...registration.data.costs,
          registerGasWei: gasEstimate.gasWei,
          registerGasEth: gasEstimate.gasEth,
          isRegisterEstimate: false, // Now it's accurate
        },
      });

      // Calculate total remaining cost
      const remainingCost = commitment.domainPriceWei + gasEstimate.gasWei;
      const remainingCostEth = formatEther(remainingCost);

      await handler.sendMessage(
        channelId,
        `⏰ **Ready to complete registration!**

The waiting period is over. Let's finish registering **${commitment.name}**.

💰 **Final Cost**
├─ Domain price: ${formatEther(commitment.domainPriceWei)} ETH
└─ Register tx gas: ~${gasEstimate.gasEth} ETH

**Total: ~${remainingCostEth} ETH**`,
        { threadId },
      );

      // Send confirmation for register phase
      await handler.sendInteractionRequest(
        channelId,
        {
          case: "form",
          value: {
            id: `confirm_register:${threadId}`,
            title: "Complete Registration",
            components: [
              {
                id: "confirm",
                component: {
                  case: "button",
                  value: { label: "✅ Complete Registration" },
                },
              },
              {
                id: "cancel",
                component: { case: "button", value: { label: "❌ Cancel" } },
              },
            ],
          },
        },
        hexToBytes(userId as `0x${string}`),
      );
    } catch (error) {
      console.error("Error in commit wait timer:", error);
    }
  }, waitTime);
}
