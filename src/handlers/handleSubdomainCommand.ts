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
import { sendBotMessage } from "./handle_message_utils";
import { namehash } from "viem";
import { ENS_CONTRACTS, PUBLIC_RESOLVER_ABI } from "../services/ens/constants";

export async function handleSubdomainCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: SubdomainCommand,
): Promise<void> {
  const service = getSubdomainService();
  const { names, subdomain } = command;

  // Validate subdomain info exists
  if (!subdomain || !subdomain.parent || !subdomain.label) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Missing subdomain information**\n\n` +
        `Please specify the subdomain you want to create, like: treasury.cocobot.eth`,
    );
    return;
  }

  const { parent, label, resolveAddress, owner } = subdomain;
  const fullSubname = `${label}.${parent}`;

  // Validate recipient address
  if (!resolveAddress) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Missing recipient address**\n\n` +
        `What address should **${fullSubname}** point to?\n` +
        `Please provide an Ethereum address (0x...) or ENS name.`,
    );
    return;
  }

  try {
    // Get user's EOA wallets
    const userWallets = await filterEOAs(userId as `0x${string}`);

    if (userWallets.length === 0) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **No EOA wallets found**\n\n` +
          `You need an EOA wallet (like MetaMask) connected to create subdomains.\n` +
          `Please connect an external wallet and try again.`,
      );
      return;
    }

    console.log(`handleSubdomainCommand: Checking ownership of ${parent}`);
    console.log(`handleSubdomainCommand: User wallets:`, userWallets);

    // Verify parent domain ownership (auto-detects wrapped vs unwrapped)
    const ownershipResult = await service.verifyParentOwnership(
      parent,
      userWallets,
    );

    console.log(`handleSubdomainCommand: Ownership result:`, ownershipResult);

    if (!ownershipResult.owned) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Validation Failed**\n\n${ownershipResult.error}`,
      );
      return;
    }

    const ownerWallet = ownershipResult.ownerWallet!;
    const isWrapped = ownershipResult.isWrapped;

    // Check if subdomain already exists
    const exists = await service.subnameExists(fullSubname);
    if (exists) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ **Subdomain already exists**\n\n` +
          `**${fullSubname}** is already registered.\n` +
          `You can manage it in the ENS app.`,
      );
      return;
    }

    // Display validation success
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `✅ **Validation Passed!**\n\n` +
        `• **Subdomain:** ${fullSubname}\n` +
        `• **Parent Domain:** ${parent}\n` +
        `• **Your Wallet:** \`${formatAddress(ownerWallet)}\`\n` +
        `• **Recipient:** \`${formatAddress(resolveAddress)}\`\n` +
        `• **Parent Type:** ${isWrapped ? "Wrapped (NameWrapper)" : "Unwrapped (Registry)"}\n\n` +
        `📝 **This will:**\n` +
        `1. Create the subdomain with recipient as owner\n` +
        `2. Set the address record to point to recipient\n\n` +
        `💰 **Cost:** Gas only (~$2-5 per transaction)\n\n` +
        `⚠️ **Note:** This requires 2 transactions.`,
    );

    // Parse the subname to get nodes
    const parsed = parseSubname(fullSubname);
    if (!parsed) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `❌ Failed to parse subdomain. Please try again.`,
      );
      return;
    }

    // Build the create subdomain transaction
    const createSubnameTx = service.buildCreateSubnameTransaction({
      fullSubname,
      owner: resolveAddress, // The recipient becomes the owner
      isWrapped,
    });

    // Store state for tracking the multi-step process
    await setSubdomainState(userId, threadId, {
      userId,
      channelId,
      threadId,
      subdomain: label,
      domain: parent,
      fullName: fullSubname,
      recipient: resolveAddress,
      ownerWallet: ownerWallet,
      isWrapped: isWrapped,
      timestamp: Date.now(),
      status: "pending",
    });

    // Send first transaction request (create subdomain)
    await handler.sendInteractionRequest(
      channelId,
      {
        type: "transaction",
        id: `subdomain_step1:${userId}:${threadId}`,
        title: `Create Subdomain: ${fullSubname}`,
        tx: {
          chainId: "1",
          to: createSubnameTx.to,
          value: "0",
          data: createSubnameTx.data,
          signerWallet: ownerWallet, // Parent owner signs this
        },
        recipient: userId as `0x${string}`,
      },
      { threadId },
    );

    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `📤 **Step 1 of 2: Create Subdomain**\n\n` +
        `Please approve the transaction to create **${fullSubname}**.\n\n` +
        `After this completes, you'll be prompted for Step 2.`,
    );
  } catch (error) {
    console.error("Error in subdomain command:", error);
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ An unexpected error occurred. Please try again later.`,
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

  // Build step 2 transaction - set the address record
  const subdomainNode = namehash(state.fullName) as `0x${string}`;

  // Encode setAddr call
  const { encodeFunctionData } = await import("viem");
  const setAddrData = encodeFunctionData({
    abi: PUBLIC_RESOLVER_ABI,
    functionName: "setAddr",
    args: [subdomainNode, state.recipient as `0x${string}`],
  });

  // Send second transaction request
  // NOTE: This transaction should be signed by the NEW OWNER (recipient)
  // who now owns the subdomain after Step 1
  const signerWallet = state.recipient;

  await handler.sendInteractionRequest(
    channelId,
    {
      type: "transaction",
      id: `subdomain_step2:${userId}:${originalThreadId}`,
      title: `Set Address: ${state.fullName}`,
      tx: {
        chainId: "1",
        to: ENS_CONTRACTS.PUBLIC_RESOLVER,
        value: "0",
        data: setAddrData,
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
