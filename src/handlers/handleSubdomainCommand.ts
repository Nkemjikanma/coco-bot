import { BotHandler } from "@towns-protocol/bot";
import { EventType, ParsedCommand, SubdomainCommand } from "../types";
import {
  getSubdomainService,
  SubdomainService,
} from "../services/ens/subdomain/subdomain";
import { filterEOAs, formatAddress } from "../utils";
import {
  clearSubdomainState,
  getSubdomainState,
  setSubdomainState,
  updateSubdomainState,
} from "../db/subdomainStore";
import { parseSubname } from "../services/ens/subdomain/subdomain.utils";

export async function handleSubdomainCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: SubdomainCommand,
): Promise<void> {
  const service = getSubdomainService();
  const { action, names, subdomain } = command;

  if (!subdomain) {
    return;
  }
  const { parent, label, resolveAddress: recipientInput, owner } = subdomain;

  const messageOptions = threadId ? { threadId } : undefined;
  const subdomainInput = `${label}.${parent}`;
  try {
    // Get user's EOA wallets
    const userWallets = await filterEOAs(userId as `0x${string}`);

    if (userWallets.length === 0) {
      await handler.sendMessage(
        channelId,
        `❌ **No EOA wallets found**\n\n` +
          `You need an EOA wallet (like MetaMask) connected to create subdomains.\n` +
          `Please connect an external wallet and try again.`,
        { threadId },
      );
      return;
    }

    if (!recipientInput) {
      await handler.sendMessage(
        channelId,
        `❌ **Haven't found any recipient addresses**\n\n` +
          `Let's start again.\n` +
          { threadId },
      );
      return;
    }

    // Prepare and validate the subdomain assignment
    const prepareResult = await service.prepareSubdomainAssignment(
      subdomainInput,
      recipientInput,
      userWallets,
    );

    if (!prepareResult.success) {
      await handler.sendMessage(
        channelId,
        `❌ **Validation Failed**\n\n${prepareResult.reason}`,
        { threadId },
      );
      return;
    }

    const {
      fullName,
      subdomain,
      domain,
      parentNode,
      subdomainNode,
      labelHash,
      recipient,
      ownerWallet,
      isWrapped,
    } = prepareResult;

    // Display validation success
    await handler.sendMessage(
      channelId,
      `✅ **Validation Passed!**\n\n` +
        `• **Subdomain:** ${fullName}\n` +
        `• **Parent Domain:** ${domain}\n` +
        `• **Your Wallet:** \`${formatAddress(ownerWallet!)}\`\n` +
        `• **Recipient:** \`${formatAddress(recipient!)}\`\n` +
        `• **Parent Type:** ${isWrapped ? "Wrapped (NameWrapper)" : "Unwrapped (Registry)"}\n\n` +
        `📝 **This will:**\n` +
        `1. Create the subdomain with recipient as owner\n` +
        `2. Set the address record to point to recipient\n\n` +
        `💰 **Cost:** Gas only (~$2-5 per transaction)\n\n` +
        `⚠️ **Note:** This requires 2 transactions.`,
      { threadId },
    );

    // Build transactions
    const transactions = service.buildSubdomainAssignmentTransactions({
      fullSubname: fullName!,
      recipient: recipient!,
      isWrapped: isWrapped!,
    });

    // Store state for tracking the multi-step process
    const assignmentId = `subdomain:${userId}:${threadId}`;

    await setSubdomainState(userId, threadId, {
      userId,
      channelId,
      threadId,
      subdomain: subdomain!,
      domain: domain!,
      fullName: fullName!,
      recipient: recipient!,
      ownerWallet: ownerWallet!,
      isWrapped: isWrapped!,
      timestamp: Date.now(),
      status: "pending",
    });

    // Send first transaction request (create subdomain)
    await handler.sendInteractionRequest(
      channelId,
      {
        type: "transaction",
        id: `subdomain_step1:${userId}:${threadId}`,
        title: `Create Subdomain: ${fullName}`,
        tx: {
          chainId: "1",
          to: transactions.step1_createSubname.to,
          value: "0",
          data: transactions.step1_createSubname.data,
          signerWallet: ownerWallet,
        },
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );

    await handler.sendMessage(
      channelId,
      `📤 **Step 1 of 2: Create Subdomain**\n\n` +
        `Please approve the transaction to create **${fullName}**.\n\n` +
        `After this completes, you'll be prompted for Step 2.`,
      { threadId },
    );
  } catch (error) {
    console.error("Error in subdomain command:", error);
    await handler.sendMessage(
      channelId,
      `❌ An unexpected error occurred. Please try again later.`,
      { threadId },
    );
  }
}

export async function handleSubdomainStep1Transaction(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  tx: {
    requestId: string;
    txHash: string;
  },
): Promise<void> {
  const { userId, channelId, eventId } = event;
  const service = getSubdomainService();

  // Extract threadId from requestId
  const parts = tx.requestId.split(":");
  const originalThreadId = parts[2];
  const validThreadId = event.threadId || originalThreadId || eventId;

  // Get stored state
  const stateResult = await getSubdomainState(userId, originalThreadId);

  if (!stateResult.success || !stateResult.data) {
    await handler.sendMessage(
      channelId,
      `❌ Subdomain assignment state not found. Please start again.`,
      { threadId: validThreadId },
    );
    return;
  }

  const state = stateResult.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `The subdomain creation was cancelled.`,
      { threadId: validThreadId },
    );
    await clearSubdomainState(userId, originalThreadId);
    return;
  }

  // Transaction submitted successfully
  await handler.sendMessage(
    channelId,
    `✅ **Step 1 Complete!**\n\n` +
      `Subdomain created: **${state.fullName}**\n` +
      `Tx: \`${tx.txHash}\`\n\n` +
      `Now proceeding to Step 2: Set address record...`,
    { threadId: validThreadId },
  );

  // Update state
  await updateSubdomainState(userId, originalThreadId, {
    status: "step1_complete",
    step1TxHash: tx.txHash,
  });

  // Build step 2 transaction
  const subdomainNode = parseSubname(state.fullName)?.parentNode;
  if (!subdomainNode) {
    await handler.sendMessage(
      channelId,
      `❌ Failed to parse subdomain. Please try again.`,
      { threadId: validThreadId },
    );
    return;
  }

  const step2Tx = service.buildSetAddressRecord({
    subdomainNode: subdomainNode,
    address: state.recipient,
  });

  // Send second transaction request
  // NOTE: This transaction should be signed by the NEW OWNER (recipient)
  // If recipient is different from ownerWallet, they need to sign
  const signerWallet = state.recipient; // New owner signs this

  await handler.sendInteractionRequest(
    channelId,
    {
      type: "transaction",
      id: `subdomain_step2:${userId}:${originalThreadId}`,
      title: `Set Address: ${state.fullName}`,
      tx: {
        chainId: "1",
        to: step2Tx.to,
        value: "0",
        data: step2Tx.data,
        signerWallet: signerWallet,
      },
      recipient: userId as `0x${string}`,
    },
    { threadId: validThreadId },
  );

  await handler.sendMessage(
    channelId,
    `📤 **Step 2 of 2: Set Address Record**\n\n` +
      `Please approve the transaction to point **${state.fullName}** to \`${formatAddress(state.recipient)}\`.`,
    { threadId: validThreadId },
  );
}

export async function handleSubdomainStep2Transaction(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  tx: {
    requestId: string;
    txHash: string;
  },
): Promise<void> {
  const { userId, channelId, eventId } = event;

  // Extract threadId from requestId
  const parts = tx.requestId.split(":");
  const originalThreadId = parts[2];
  const validThreadId = event.threadId || originalThreadId || eventId;

  // Get stored state
  const stateResult = await getSubdomainState(userId, originalThreadId);

  if (!stateResult.success || !stateResult.data) {
    await handler.sendMessage(
      channelId,
      `❌ Subdomain assignment state not found.`,
      { threadId: validThreadId },
    );
    return;
  }

  const state = stateResult.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `The address record was not set.\n\n` +
        `Note: The subdomain **${state.fullName}** was created in Step 1.\n` +
        `You can set the address record later using the ENS app.`,
      { threadId: validThreadId },
    );
    await clearSubdomainState(userId, originalThreadId);
    return;
  }

  // Success!
  await handler.sendMessage(
    channelId,
    `🎉 **Subdomain Assignment Complete!**\n\n` +
      `**${state.fullName}** now points to:\n` +
      `\`${state.recipient}\`\n\n` +
      `**Transaction Details:**\n` +
      `• Step 1 (Create): \`${state.step1TxHash}\`\n` +
      `• Step 2 (Set Address): \`${tx.txHash}\`\n\n` +
      `The subdomain is now active and ready to use! 🚀`,
    { threadId: validThreadId },
  );

  // Clean up state
  await clearSubdomainState(userId, originalThreadId);
}

// ============ Main router for subdomain transactions ============

export async function handleSubdomainTransaction(
  handler: BotHandler,
  event: {
    userId: string;
    channelId: string;
    threadId?: string;
    eventId: string;
  },
  tx: {
    requestId: string;
    txHash: string;
  },
): Promise<void> {
  if (tx.requestId.startsWith("subdomain_step1:")) {
    await handleSubdomainStep1Transaction(handler, event, tx);
  } else if (tx.requestId.startsWith("subdomain_step2:")) {
    await handleSubdomainStep2Transaction(handler, event, tx);
  } else {
    console.error("Unknown subdomain transaction requestId:", tx.requestId);
  }
}
