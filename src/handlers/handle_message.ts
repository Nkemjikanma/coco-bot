import {
  type BotHandler,
  FlattenedFormComponent,
  getSmartAccountFromUserId,
} from "@towns-protocol/bot";
import { formatEther, isAddress } from "viem";
import { coco_parser, handleQuestionCommand, validate_parse } from "../ai";
import {
  type ApiResponse,
  type ExpiryData,
  formatCheckResponse,
  formatExpiryResponse,
  formatHistoryResponse,
  formatPhase1Summary,
  formatPortfolioResponse,
  type HistoryData,
  type PortfolioData,
} from "../api";
import { formatMultiWalletPortfolio } from "../api/formatResponses";
import { bot } from "../bot";
import {
  appendMessageToSession,
  clearActiveFlow,
  clearUserPendingCommand,
  createRegistrationFlow,
  describePendingCommand,
  // ✅ New flow store imports
  getActiveFlow,
  getRecentMessages,
  getUserState,
  hasAnyActiveFlow,
  hasPendingCommandElsewhere,
  isRegistrationFlow,
  movePendingCommandToThread,
  setActiveFlow,
  setUserPendingCommand,
  updateFlowData,
  updateFlowStatus,
  updateUserLocation,
} from "../db";
import { CHAIN_IDS } from "../services/bridge";
import { handleBridging } from "../services/bridge/bridgeUtils";
import {
  checkAvailability,
  checkExpiry,
  encodeCommitData,
  estimateRegistrationCost,
  getHistory,
  getUserPorfolio,
  prepareRegistration,
} from "../services/ens";
import { ENS_CONTRACTS } from "../services/ens/constants";
import { isCompleteSubdomainInfo } from "../services/ens/subdomain/subdomain.utils";
import { handleExecutionsForCheckingSubdomains } from "../services/ens/utils";
import type {
  EOAWalletCheckResult,
  EventType,
  OnMessageEventType,
  ParsedCommand,
  PendingCommand,
  QuestionCommand,
  RegisterCommand,
  SubdomainCommand,
} from "../types";
import {
  checkAllEOABalances,
  checkBalance,
  extractRecipientAddress,
  filterEOAs,
  formatAddress,
  formatAllWalletBalances,
  getLinkedWallets,
} from "../utils";
import {
  determineWaitingFor,
  extractMissingInfo,
  formatRustPayload,
  getHelpMessage,
  getWaitingForMessage,
  sendBotMessage,
} from "./handle_message_utils";
import { handleRegisterCommand } from "./handleRegisterCommand";
import { handleSubdomainCommand } from "./handleSubdomainCommand";
import { handleTransferCommand } from "./handleTransferCommand";

type UnifiedEvent = {
  channelId: string;
  userId: string;
  eventId: string;
  threadId: string | undefined;
  content: string;
  source: "slash_command" | "natural_language";
};

// Normalize slash command and natural language into a unified format
function normalizeEvent(
  event: EventType | OnMessageEventType,
  source: "slash_command" | "natural_language",
): UnifiedEvent {
  if (source === "slash_command") {
    const slashEvent = event as EventType;
    return {
      channelId: slashEvent.channelId,
      userId: slashEvent.userId,
      eventId: slashEvent.eventId,
      threadId: slashEvent.threadId,
      content: `${slashEvent.command} ${slashEvent.args.join(" ")}`,
      source,
    };
  } else {
    const messageEvent = event as OnMessageEventType;
    return {
      channelId: messageEvent.channelId,
      userId: messageEvent.userId,
      eventId: messageEvent.eventId,
      threadId: messageEvent.threadId,
      content: messageEvent.message,
      source,
    };
  }
}

/**
 * Handler for onSlashCommand
 */
export async function handleSlashCommand(
  handler: BotHandler,
  event: EventType,
): Promise<void> {
  await handleMessage(handler, event, "slash_command");
}

/**
 * Handler for onMessage
 */
export async function handleOnMessage(
  handler: BotHandler,
  event: OnMessageEventType,
): Promise<void> {
  await handleMessage(handler, event, "natural_language");
}

/**
 * Main message handler
 */
export async function handleMessage(
  handler: BotHandler,
  event: EventType | OnMessageEventType,
  source: "slash_command" | "natural_language",
): Promise<void> {
  const unified = normalizeEvent(event, source);
  const { channelId, userId, eventId, content } = unified;
  const threadId = unified.threadId || eventId;

  // Skip empty messages
  if (!content || content.trim() === "") {
    return;
  }

  // Store message in session
  await appendMessageToSession(threadId, userId, {
    eventId,
    content,
    timestamp: Date.now(),
    role: "user",
  });

  try {
    // Check if user has another conversation going on elsewhere
    const elsewhereCheck = await hasPendingCommandElsewhere(userId, threadId);

    if (elsewhereCheck.pendingThreadId && elsewhereCheck.pendingCommand) {
      const lowerContent = content.toLowerCase();

      if (
        lowerContent.includes("continue here") ||
        lowerContent.includes("yes")
      ) {
        // Move pending command to this thread
        await movePendingCommandToThread(userId, threadId, channelId);

        const pending = elsewhereCheck.pendingCommand;

        if (pending.waitingFor === "confirmation") {
          const pendingAction = pending.partialCommand?.action;

          if (pendingAction === "register") {
            const flowResult = await getActiveFlow(
              userId,
              elsewhereCheck.pendingThreadId!,
            );

            if (!flowResult.success || !isRegistrationFlow(flowResult.data)) {
              await sendBotMessage(
                handler,
                channelId,
                threadId,
                userId,
                "Your registration data expired. Please start again with `/register`.",
              );
              await clearUserPendingCommand(userId);
              return;
            }

            const message = getWaitingForMessage(pending);
            await sendBotMessage(
              handler,
              channelId,
              threadId,
              userId,
              `Great! Continuing here.\n\n${message}`,
            );

            await handler.sendInteractionRequest(
              channelId,
              {
                type: "form",
                id: `confirm_commit:${threadId}`,
                title: "Confirm Registration: Step 1 of 2",
                components: [
                  {
                    id: "confirm",
                    type: "button",
                    label: "✅ Start Registration",
                  },
                  {
                    id: "cancel",
                    type: "button",
                    label: "❌ Cancel",
                  },
                ],
                recipient: userId as `0x${string}`,
              },
              { threadId },
            );

            return;
          }

          // For other actions waiting for confirmation, just execute them
          if (pending.partialCommand) {
            await sendBotMessage(
              handler,
              channelId,
              threadId,
              userId,
              "Great! Continuing here...",
            );
            await clearUserPendingCommand(userId);
            await executeValidCommand(
              handler,
              channelId,
              threadId,
              userId,
              pending.partialCommand as ParsedCommand,
            );
            return;
          }
        }

        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "Great! Continuing here. " +
            getWaitingForMessage(elsewhereCheck.pendingCommand),
        );

        if (pending.partialCommand) {
          await clearUserPendingCommand(userId);
          await executeValidCommand(
            handler,
            channelId,
            threadId,
            userId,
            pending.partialCommand as ParsedCommand,
          );
          return;
        }
        return;
      } else if (
        lowerContent.includes("start fresh") ||
        lowerContent.includes("cancel") ||
        lowerContent.includes("no")
      ) {
        // ✅ Clear all state including flows
        await clearUserPendingCommand(userId);
        if (elsewhereCheck.pendingThreadId) {
          await clearActiveFlow(userId, elsewhereCheck.pendingThreadId);
        }
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "No problem! Starting fresh. What would you like to do? 🆕",
        );
        return;
      } else {
        const description = describePendingCommand(
          elsewhereCheck.pendingCommand,
        );
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          `👋 Hey! I noticed you started something in another chat:\n\n${description}\n\n` +
            `Would you like to:\n` +
            `• **"Continue here"** - Pick up where you left off\n` +
            `• **"Start fresh"** - Cancel that and start something new`,
        );
        return;
      }
    }

    // Check if user is responding to a pending command in THIS thread
    const userState = await getUserState(userId);

    if (userState?.pendingCommand && userState.activeThreadId === threadId) {
      const lowerContent = content.toLowerCase().trim();
      const isNewCommand =
        lowerContent.startsWith("register ") ||
        lowerContent.startsWith("check ") ||
        lowerContent.startsWith("expiry ") ||
        lowerContent.startsWith("history ") ||
        lowerContent.startsWith("portfolio ") ||
        lowerContent.startsWith("/");

      if (isNewCommand) {
        // ✅ Clear all state with new API
        await clearUserPendingCommand(userId);
        await clearActiveFlow(userId, threadId);
        // Fall through to normal parsing
      } else {
        await handlePendingCommandResponse(
          handler,
          channelId,
          threadId,
          userId,
          content,
          userState.pendingCommand,
        );
        return;
      }
    }

    // Parse the message using Claude
    const recentMessages = await getRecentMessages(threadId, 5);
    const parserResult = await coco_parser(content, recentMessages);

    console.log("parser", parserResult);

    if (!parserResult.success) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        parserResult.userMessage,
      );
      return;
    }

    console.log(parserResult.parsed);

    // Validate the parsed command
    const validation = validate_parse(parserResult.parsed);

    if (!validation.valid) {
      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        validation.partial,
        determineWaitingFor(validation.partial),
      );

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        validation.question,
      );
      return;
    }

    // Valid command!
    await clearUserPendingCommand(userId);
    await updateUserLocation(userId, threadId, channelId);

    const command = validation.command;
    await executeValidCommand(handler, channelId, threadId, userId, command);
  } catch (error) {
    console.error("Error in message handler:", error);
    const errorMsg =
      "Oops! Something went wrong on my end. Can you try that again? 🔧";
    await sendBotMessage(handler, channelId, threadId, userId, errorMsg);
  }
}

export async function handlePendingCommandResponse(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  content: string,
  pending: PendingCommand,
): Promise<void> {
  const lowerContent = content.toLowerCase();

  // Check for cancellation
  if (
    lowerContent.includes("cancel") ||
    lowerContent.includes("nevermind") ||
    lowerContent.includes("never mind") ||
    lowerContent.includes("stop")
  ) {
    await clearUserPendingCommand(userId);
    await clearActiveFlow(userId, threadId);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "No problem! Let me know if you want to do something else. 👋",
    );
    return;
  }

  if (pending.waitingFor === "duration") {
    // Extract number from the response
    const durationMatch = content.match(/(\d+)/);

    if (!durationMatch) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I couldn't find a number in your response. How many years would you like to register for? (1-10)",
      );
      return;
    }

    const duration = parseInt(durationMatch[1], 10);

    if (Number.isNaN(duration) || duration < 1 || duration > 10) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Please enter a valid duration between 1 and 10 years.",
      );
      return;
    }

    const partialCommand = pending.partialCommand as RegisterCommand;

    if (!partialCommand.name || partialCommand.name.length === 0) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I lost track of which names you wanted to register. Please start again.",
      );
      await clearUserPendingCommand(userId);
      return;
    }

    const updatedCommand: RegisterCommand = {
      action: "register",
      name: partialCommand.name,
      duration,
    };

    // Clear pending and execute the complete command
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

  if (pending.waitingFor === "confirmation") {
    const pendingAction = pending.partialCommand?.action;

    // Only handle registration confirmations specially
    if (pendingAction === "register") {
      if (lowerContent.includes("confirm") || lowerContent.includes("yes")) {
        // ✅ Use new API
        const flowResult = await getActiveFlow(userId, threadId);

        if (!flowResult.success || !isRegistrationFlow(flowResult.data)) {
          await sendBotMessage(
            handler,
            channelId,
            threadId,
            userId,
            "Your registration data expired. Please start again.",
          );
          await clearUserPendingCommand(userId);
          return;
        }

        const flow = flowResult.data;
        const regData = flow.data;
        const firstCommitment = regData.commitment;

        if (!firstCommitment || !firstCommitment.commitment) {
          await sendBotMessage(
            handler,
            channelId,
            threadId,
            userId,
            "Registration data is incomplete. Please start again with `/register`.",
          );
          await clearUserPendingCommand(userId);
          await clearActiveFlow(userId, threadId);
          return;
        }

        const commitData = encodeCommitData(firstCommitment?.commitment);
        const commitmentId = `commit:${userId}:${Date.now()}`;

        // ✅ Update flow status
        await updateFlowStatus(userId, threadId, "step1_pending");

        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "🚀 Starting registration...\n\nPlease approve the commit transaction.",
        );

        await handler.sendInteractionRequest(
          channelId,
          {
            type: "transaction",
            id: commitmentId,
            title: `Commit ENS Registration: ${firstCommitment?.name}`,
            tx: {
              chainId: "1",
              to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
              value: "0",
              data: commitData,
              signerWallet: regData.selectedWallet || undefined,
            },
            recipient: userId as `0x${string}`,
          },
          { threadId },
        );

        return;
      } else {
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "Please say **confirm** to proceed with the registration, or **cancel** to stop.",
        );
        return;
      }
    }

    // For non-registration actions waiting for confirmation,
    // re-execute the command (it should be complete at this point)
    if (pending.partialCommand) {
      await clearUserPendingCommand(userId);
      await executeValidCommand(
        handler,
        channelId,
        threadId,
        userId,
        pending.partialCommand as ParsedCommand,
      );
      return;
    }
  }

  if (pending.waitingFor === "subdomain_address") {
    const userMessage = content.trim();

    const isENSName = userMessage.toLowerCase().endsWith(".eth");
    if (!isENSName && !isAddress(userMessage)) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `"${userMessage}" doesn't look like a valid address. Please provide an Ethereum address (0x...) or ENS name (.eth).`,
      );
      return;
    }

    const partialCommand = pending.partialCommand as SubdomainCommand;

    if (!partialCommand.subdomain?.parent || !partialCommand.subdomain?.label) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I lost track of which subdomain you wanted to create. Let's start again - which subdomain would you like to create?",
      );
      await clearUserPendingCommand(userId);
      return;
    }

    const updatedCommand: SubdomainCommand = {
      ...partialCommand,
      subdomain: {
        parent: partialCommand.subdomain.parent,
        label: partialCommand.subdomain.label,
        resolveAddress: userMessage as `0x${string}`,
        owner: userMessage as `0x${string}`,
      },
    };

    const validation = validate_parse(updatedCommand);

    if (validation.valid) {
      await clearUserPendingCommand(userId);
      await handleSubdomainCommand(
        handler,
        channelId,
        threadId,
        userId,
        validation.command as SubdomainCommand,
      );
      return;
    } else {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        validation.question || "Something went wrong. Please try again.",
      );

      await setUserPendingCommand(
        userId,
        threadId,
        channelId,
        validation.partial,
        determineWaitingFor(validation.partial),
      );
      return;
    }
  }

  const updated = extractMissingInfo(
    pending.partialCommand,
    content,
    pending.waitingFor,
  );

  const validation = validate_parse(updated);

  if (!validation.valid) {
    if (pending.attemptCount >= 3) {
      await clearUserPendingCommand(userId);
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I'm having a bit of trouble understanding. Let's start fresh! What would you like to do? 🔄",
      );
      return;
    }

    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      validation.partial,
      determineWaitingFor(validation.partial),
    );

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      validation.question,
    );
    return;
  }

  await clearUserPendingCommand(userId);
  await updateUserLocation(userId, threadId, channelId);

  const command = validation.command;
  await executeValidCommand(handler, channelId, threadId, userId, command);
}

export async function executeValidCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: ParsedCommand,
): Promise<void> {
  if (command.action === "question") {
    const answer = await handleQuestionCommand(command as QuestionCommand);
    await sendBotMessage(handler, channelId, threadId, userId, answer);
    return;
  }

  if (command.action === "help") {
    const helpMessage = getHelpMessage();
    await sendBotMessage(handler, channelId, threadId, userId, helpMessage);
    return;
  }

  if (command.action === "check") {
    if (command.name.split(".").length > 2) {
      await handleExecutionsForCheckingSubdomains(
        handler,
        channelId,
        threadId,
        userId,
      );
      return;
    }

    const checkResult = await checkAvailability(command.name);
    if (!checkResult.success) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Sorry, I couldn't check that name right now.",
      );
      return;
    }

    const checkData = formatCheckResponse(checkResult.data);
    await sendBotMessage(handler, channelId, threadId, userId, checkData);
    return;
  }

  if (command.action === "expiry") {
    if (command.name.split(".").length > 2) {
      await handleExecutionsForCheckingSubdomains(
        handler,
        channelId,
        threadId,
        userId,
      );
      return;
    }

    const expiryResult: ApiResponse<ExpiryData> = await checkExpiry(
      command.name,
    );

    if (!expiryResult.success) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Sorry, I couldn't check expiry info on that name right now.",
      );
      return;
    }
    const expiryData = formatExpiryResponse(expiryResult.data);
    await sendBotMessage(handler, channelId, threadId, userId, expiryData);
    return;
  }

  if (command.action === "history") {
    if (command.name.split(".").length > 2) {
      await handleExecutionsForCheckingSubdomains(
        handler,
        channelId,
        threadId,
        userId,
      );
      return;
    }

    if (command.name.length > 1) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `I'll get history for just the first name "${command.name[0]}" because the data returned for history is usually long`,
      );
    }

    const historyResult: HistoryData = await getHistory(command.name[0]);
    const historyData = formatHistoryResponse(command.name[0], historyResult);
    await sendBotMessage(handler, channelId, threadId, userId, historyData);
    return;
  }

  if (command.action === "portfolio") {
    let addressesToQuery: `0x${string}`[] = [];

    // Check if user wants their own wallets
    if (command.useSelfWallets || !command.address) {
      // Fetch user's wallets from Towns
      const userWallets = await filterEOAs(userId as `0x${string}`);
      const smartWallet = await getSmartAccountFromUserId(bot, {
        userId: userId as `0x${string}`,
      });

      // Combine all wallets
      addressesToQuery = [...userWallets];
      if (smartWallet) {
        addressesToQuery.push(smartWallet);
      }

      if (addressesToQuery.length === 0) {
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "I couldn't find any wallets linked to your account. Please connect a wallet first.",
        );
        return;
      }
    } else if (command.address && isAddress(command.address)) {
      addressesToQuery = [command.address];
    } else {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "I need a valid wallet address to show the portfolio. Please provide an Ethereum address (0x...) or say 'my wallets' to see your own.",
      );
      return;
    }

    // Query portfolio for all addresses
    const allResults: PortfolioData[] = [];

    for (const addr of addressesToQuery) {
      const portfolioResult = await getUserPorfolio(addr);
      if (portfolioResult) {
        allResults.push({ ...portfolioResult });
      }
    }

    if (
      allResults.length === 0 ||
      allResults.every((r) => r.names?.length === 0)
    ) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `I checked ${addressesToQuery.length} wallet(s) but didn't find any ENS names. You can register one with \`/register yourname.eth\``,
      );
      return;
    }

    // Format combined results
    const portfolioData = formatMultiWalletPortfolio(
      addressesToQuery,
      allResults,
    );
    await sendBotMessage(handler, channelId, threadId, userId, portfolioData);
    return;
  }
  console.log("handleValid", command.name);

  await handleExecution(handler, channelId, threadId, userId, command);
}

async function handleExecution(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: ParsedCommand,
) {
  if (command.action === "subdomain") {
    if (!isCompleteSubdomainInfo(command.subdomain)) {
      const subdomain = command.subdomain;

      if (!subdomain?.parent || !subdomain?.label) {
        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          "I lost track of which subdomain you wanted to create. Could you tell me again? For example: blog.yourname.eth",
        );

        await setUserPendingCommand(
          userId,
          threadId,
          channelId,
          { action: "subdomain", name: "" },
          "name",
        );
        return;
      }

      if (!subdomain?.resolveAddress) {
        const fullName = `${subdomain.label}.${subdomain.parent}`;

        await sendBotMessage(
          handler,
          channelId,
          threadId,
          userId,
          `What address should **${fullName}** point to? Please provide an Ethereum address (0x...) or ENS name.`,
        );

        await setUserPendingCommand(
          userId,
          threadId,
          channelId,
          {
            action: "subdomain",
            name: fullName,
            subdomain: {
              parent: subdomain.parent,
              label: subdomain.label,
            },
          },
          "subdomain_address",
        );
        return;
      }

      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "Something went wrong with your subdomain request. Please try again.",
      );
      await clearUserPendingCommand(userId);
      return;
    }
    await handleSubdomainCommand(handler, channelId, threadId, userId, command);
  }

  if (command.action === "register") {
    await handleRegisterCommand(handler, channelId, threadId, userId, command);
  }

  if (command.action === "transfer") {
    await handleTransferCommand(handler, channelId, threadId, userId, command);
  }
}

export async function proceedWithRegistration(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: RegisterCommand,
  selectedWallet: `0x${string}`,
  walletCheck: EOAWalletCheckResult,
) {
  try {
    const registration = await prepareRegistration({
      name: command.name,
      owner: selectedWallet,
      durationYears: command.duration,
    });

    const walletInfo = walletCheck.wallets.find(
      (w) => w.address.toLowerCase() === selectedWallet.toLowerCase(),
    );

    if (!walletInfo) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        "❌ Wallet not found. Please try again.",
      );
      return;
    }

    // Create registration flow
    const registrationFlow = createRegistrationFlow({
      userId,
      threadId,
      channelId,
      status: "initiated",
      data: {
        ...registration,
        selectedWallet,
        walletCheckResult: walletCheck,
      },
    });
    await setActiveFlow(registrationFlow);

    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      "confirmation",
    );

    const balanceMessage =
      walletInfo.l1Balance >= registration.grandTotalWei
        ? `✅ L1 Balance: ${Number(walletInfo.l1BalanceEth).toFixed(4)} ETH (sufficient)`
        : `⚠️ L1 Balance: ${Number(walletInfo.l1BalanceEth).toFixed(4)} ETH (need bridging)`;

    const summary = formatPhase1Summary(registration, command.duration);

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `${summary}\n\n` +
        `💰 **Wallet:** ${formatAddress(selectedWallet)}\n` +
        `${balanceMessage}\n\n` +
        `⚠️ **Note:** ENS registration happens on Ethereum Mainnet (L1). \n\n` +
        `Make sure to select the correct wallet when approving transactions. \n\n`,
    );

    await handler.sendInteractionRequest(
      channelId,
      {
        type: "form",
        id: `confirm_commit:${threadId}`,
        title: "Confirm Registration: Step 1 of 2",
        components: [
          {
            id: "confirm",
            type: "button",
            label: "✅ Start Registration",
          },
          {
            id: "cancel",
            type: "button",
            label: "❌ Cancel",
          },
        ],
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );
  } catch (e) {
    console.error("Error preparing registration:", e);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      "Something went wrong. Please try again.",
    );
  }
}
