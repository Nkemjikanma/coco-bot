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
import { encodeFunctionData, namehash } from "viem";
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

    // ✅ CHECK: Is the recipient one of the user's wallets?
    const isRecipientUser = userWallets.some(
      (w) => w.toLowerCase() === resolveAddress.toLowerCase(),
    );

    console.log(
      `handleSubdomainCommand: Recipient is user's wallet: ${isRecipientUser}`,
    );

    // Determine if we can do Step 2
    const canDoStep2 = isRecipientUser;

    // Display validation success with appropriate message
    if (canDoStep2) {
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
          `1. Create the subdomain with you as owner\n` +
          `2. Set the address record to point to your wallet\n\n` +
          `💰 **Cost:** Gas only (~$2-5 per transaction)\n\n` +
          `⚠️ **Note:** This requires 2 transactions.`,
      );
    } else {
      // Recipient is NOT the user - only Step 1 possible
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
          `• Create the subdomain with recipient as owner\n\n` +
          `⚠️ **Note:** Since the recipient is not your wallet, they will need to set the address record themselves using the ENS app after the subdomain is created.\n\n` +
          `💰 **Cost:** Gas only (~$2-5)`,
      );
    }

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

    // Store state for tracking
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
      canDoStep2: canDoStep2, // ✅ Store whether Step 2 is possible
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

    if (canDoStep2) {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `📤 **Step 1 of 2: Create Subdomain**\n\n` +
          `Please approve the transaction to create **${fullSubname}**.\n\n` +
          `After this completes, you'll be prompted for Step 2.`,
      );
    } else {
      await sendBotMessage(
        handler,
        channelId,
        threadId,
        userId,
        `📤 **Creating Subdomain**\n\n` +
          `Please approve the transaction to create **${fullSubname}**.\n\n` +
          `The recipient will own this subdomain and can configure it via the ENS app.`,
      );
    }
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

  // Update state with tx hash
  await updateSubdomainState(userId, originalThreadId, {
    status: "step1_complete",
    step1TxHash: tx.txHash,
  });

  // ✅ CHECK: Can we proceed to Step 2?
  if (!state.canDoStep2) {
    // Recipient is not the user - we're done!
    await handler.sendMessage(
      channelId,
      `🎉 **Subdomain Created!**\n\n` +
        `**${state.fullName}** has been created and is now owned by:\n` +
        `\`${state.recipient}\`\n\n` +
        `**Transaction:** \`${tx.txHash}\`\n\n` +
        `ℹ️ The new owner can set the address record and other configurations using the ENS app at [app.ens.domains](https://app.ens.domains).`,
      { threadId: validThreadId },
    );

    // Clean up state
    await clearSubdomainState(userId, originalThreadId);
    return;
  }

  // Proceed to Step 2 - user can sign because they're the recipient
  await handler.sendMessage(
    channelId,
    `✅ **Step 1 Complete!**\n\n` +
      `Subdomain created: **${state.fullName}**\n` +
      `Tx: \`${tx.txHash}\`\n\n` +
      `Now proceeding to Step 2: Set address record...`,
    { threadId: validThreadId },
  );

  // Build step 2 transaction - set the address record
  const subdomainNode = namehash(state.fullName) as `0x${string}`;

  const setAddrData = encodeFunctionData({
    abi: PUBLIC_RESOLVER_ABI,
    functionName: "setAddr",
    args: [subdomainNode, state.recipient as `0x${string}`],
  });

  // Send second transaction request
  // The recipient (who is now the subdomain owner) signs this
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
        signerWallet: state.recipient, // Recipient signs (they own the subdomain now)
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
  console.log(`handleSubdomainTransaction: Routing ${tx.requestId}`);

  if (tx.requestId.startsWith("subdomain_step1:")) {
    await handleSubdomainStep1Transaction(handler, event, tx);
  } else if (tx.requestId.startsWith("subdomain_step2:")) {
    await handleSubdomainStep2Transaction(handler, event, tx);
  } else {
    console.error("Unknown subdomain transaction requestId:", tx.requestId);
  }
}
