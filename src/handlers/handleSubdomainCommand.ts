import { BotHandler } from "@towns-protocol/bot";
import {
  createSubdomainFlow,
  setActiveFlow,
  setUserPendingCommand,
  getActiveFlow,
  isSubdomainFlow,
  clearActiveFlow,
  clearUserPendingCommand,
  updateFlowData,
  updateFlowStatus,
} from "../db";
import { getSubdomainService } from "../services/ens/subdomain/subdomain";
import { parseSubname } from "../services/ens/subdomain/subdomain.utils";
import { SubdomainCommand } from "../types";
import { filterEOAs, formatAddress } from "../utils";
import { sendBotMessage } from "./handle_message_utils";

/**
 * Main handler for subdomain creation command
 *
 * This implements a 3-step flow where ALL transactions are signed by the parent owner:
 * 1. Create subdomain with caller (parent owner) as temporary owner
 * 2. Set address record to point to recipient
 * 3. Transfer ownership to recipient
 *
 * This allows assigning subdomains to smart wallets that can't sign!
 */
export async function handleSubdomainCommand(
  handler: BotHandler,
  channelId: string,
  threadId: string,
  userId: string,
  command: SubdomainCommand,
): Promise<void> {
  const service = getSubdomainService();
  const { name, subdomain } = command;

  // Validate subdomain info exists
  if (!subdomain || !subdomain.parent || !subdomain.label) {
    await sendBotMessage(
      handler,
      channelId,
      threadId,
      userId,
      `❌ **Missing subdomain information**\n\n` +
        `Please specify the subdomain you want to create, like: treasury.myname.eth`,
    );
    return;
  }

  const { parent, label, resolveAddress } = subdomain;
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
    // Get user's EOA wallets (only EOAs can sign transactions)
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

    // Parse the subname to validate
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

    // Check if recipient is the same as owner (simplifies flow - skip step 3)
    const recipientIsCaller =
      ownerWallet.toLowerCase() === resolveAddress.toLowerCase();
    const totalSteps = recipientIsCaller ? 2 : 3;

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
        `• **Points to:** \`${formatAddress(resolveAddress)}\`\n` +
        `• **Owner after creation:** \`${formatAddress(resolveAddress)}\`\n` +
        `• **Parent Type:** ${isWrapped ? "Wrapped (NameWrapper)" : "Unwrapped (Registry)"}\n\n` +
        `📝 **This will:**\n` +
        `1. Create the subdomain\n` +
        `2. Set the address record\n` +
        (recipientIsCaller ? "" : `3. Transfer ownership to recipient\n`) +
        `\n💰 **Cost:** Gas only (~$3-10 for ${totalSteps} transactions)\n\n` +
        `⏳ **Note:** This requires ${totalSteps} transactions, all signed by you.`,
    );

    // Build the first transaction (create subdomain with caller as owner)
    const step1Tx = service.buildStep1_CreateSubdomain({
      fullSubname,
      caller: ownerWallet,
      isWrapped,
    });

    // Create flow to track state across transactions
    const flow = createSubdomainFlow({
      userId,
      threadId,
      channelId,
      status: "step1_pending",
      data: {
        subdomain: label,
        domain: parent,
        fullName: fullSubname,
        resolveAddress: resolveAddress,
        recipient: resolveAddress, // Final owner
        ownerWallet: ownerWallet, // Signer for all transactions
        isWrapped: isWrapped,
        currentStep: 1,
        totalSteps: totalSteps,
      },
    });

    await setActiveFlow(flow);

    await setUserPendingCommand(
      userId,
      threadId,
      channelId,
      command,
      "subdomain_confirmation",
    );

    // Send Step 1 transaction request
    await handler.sendInteractionRequest(
      channelId,
      {
        type: "transaction",
        id: `subdomain_step1:${userId}:${threadId}`,
        title: `Step 1/${totalSteps}: Create Subdomain`,
        tx: {
          chainId: "1",
          to: step1Tx.to,
          value: "0",
          data: step1Tx.data,
          signerWallet: ownerWallet,
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
      `📤 **Step 1: Create Subdomain**\n\n` +
        `Please approve the transaction to create **${fullSubname}**.\n\n` +
        `After this completes, you'll be prompted for the next step.`,
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

/**
 * Handle Step 1 transaction response (Create Subdomain)
 */
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

  // Extract threadId from requestId
  const parts = tx.requestId.split(":");
  const originalThreadId = parts[2];
  const validThreadId = event.threadId || originalThreadId || eventId;

  // Get flow
  const flowResult = await getActiveFlow(userId, originalThreadId);

  if (!flowResult.success || !isSubdomainFlow(flowResult.data)) {
    await handler.sendMessage(
      channelId,
      `❌ Subdomain flow not found. Please start again.`,
      { threadId: validThreadId },
    );
    return;
  }

  const flow = flowResult.data;
  const flowData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `The subdomain creation was cancelled.`,
      { threadId: validThreadId },
    );
    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Update flow with step 1 tx hash
  await updateFlowData(userId, originalThreadId, {
    step1TxHash: tx.txHash,
    currentStep: 2,
  });
  await updateFlowStatus(userId, originalThreadId, "step1_complete");

  await handler.sendMessage(
    channelId,
    `✅ **Step 1 Complete!**\n\n` +
      `Subdomain created: **${flowData.fullName}**\n\n` +
      `[Tx:](https://etherscan.io/tx/${tx.txHash})\n\n` +
      `Now proceeding to Step 2: Set address record...`,
    { threadId: validThreadId },
  );

  // Build Step 2 transaction (set address record)
  const service = getSubdomainService();
  const step2Tx = service.buildStep2_SetAddress({
    fullSubname: flowData.fullName,
    resolveAddress: flowData.resolveAddress as `0x${string}`,
  });

  // Update flow status
  await updateFlowStatus(userId, originalThreadId, "step2_pending");

  // Send Step 2 transaction request
  // NOTE: signerWallet is ownerWallet (parent owner), NOT recipient
  // Because the caller is still the owner at this point!
  await handler.sendInteractionRequest(
    channelId,
    {
      type: "transaction",
      id: `subdomain_step2:${userId}:${originalThreadId}`,
      title: `Step 2/${flowData.totalSteps}: Set Address Record`,
      tx: {
        chainId: "1",
        to: step2Tx.to,
        value: "0",
        data: step2Tx.data,
        signerWallet: flowData.ownerWallet as `0x${string}`, // Parent owner signs!
      },
      recipient: userId as `0x${string}`,
    },
    { threadId: validThreadId },
  );

  await handler.sendMessage(
    channelId,
    `📤 **Step 2: Set Address Record**\n\n` +
      `Please approve the transaction to point **${flowData.fullName}** to \`${formatAddress(flowData.resolveAddress as `0x${string}`)}\`.`,
    { threadId: validThreadId },
  );
}

/**
 * Handle Step 2 transaction response (Set Address Record)
 */
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

  // Get flow
  const flowResult = await getActiveFlow(userId, originalThreadId);

  if (!flowResult.success || !isSubdomainFlow(flowResult.data)) {
    await handler.sendMessage(channelId, `❌ Subdomain flow not found.`, {
      threadId: validThreadId,
    });
    return;
  }

  const flow = flowResult.data;
  const flowData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `The address record was not set.\n\n` +
        `Note: The subdomain **${flowData.fullName}** was created in Step 1.\n` +
        `You can set the address record later using the ENS app.`,
      { threadId: validThreadId },
    );
    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Update flow with step 2 tx hash
  await updateFlowData(userId, originalThreadId, {
    step2TxHash: tx.txHash,
    currentStep: 3,
  });
  await updateFlowStatus(userId, originalThreadId, "step2_complete");

  // Check if we need Step 3 (transfer ownership)
  const needsTransfer =
    flowData.ownerWallet?.toLowerCase() !== flowData.recipient?.toLowerCase();

  if (!needsTransfer) {
    // Owner IS the recipient - we're done!
    await updateFlowStatus(userId, originalThreadId, "complete");

    await handler.sendMessage(
      channelId,
      `🎉 **Subdomain Setup Complete!**\n\n` +
        `**${flowData.fullName}** now:\n\n` +
        `• Points to: \`${flowData.resolveAddress}\`\n\n` +
        `• Owned by: \`${formatAddress(flowData.ownerWallet as `0x${string}`)}\`\n\n` +
        `**Transaction Details:**\n\n` +
        `• Step 1 (Create): \`${flowData.step1TxHash}\`\n` +
        `• Step 2 (Set Address): [Tx](https://etherscan.io/tx/${tx.txHash})\n\n` +
        `The subdomain is now active and ready to use! 🚀`,
      { threadId: validThreadId },
    );

    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Need Step 3 - transfer ownership
  await handler.sendMessage(
    channelId,
    `✅ **Step 2 Complete!**\n\n` +
      `Address record set for: **${flowData.fullName}**\n` +
      `Tx: [](https://etherscan.io/tx/${tx.txHash})\n\n` +
      `Now proceeding to Step 3: Transfer ownership...`,
    { threadId: validThreadId },
  );

  // Build Step 3 transaction (transfer ownership)
  const service = getSubdomainService();
  const step3Tx = service.buildStep3_TransferOwnership({
    fullSubname: flowData.fullName,
    caller: flowData.ownerWallet as `0x${string}`,
    recipient: flowData.recipient as `0x${string}`,
    isWrapped: flowData.isWrapped,
  });

  // Update flow status
  await updateFlowStatus(userId, originalThreadId, "step3_pending");

  // Send Step 3 transaction request
  await handler.sendInteractionRequest(
    channelId,
    {
      type: "transaction",
      id: `subdomain_step3:${userId}:${originalThreadId}`,
      title: `Step 3/3: Transfer Ownership`,
      tx: {
        chainId: "1",
        to: step3Tx.to,
        value: "0",
        data: step3Tx.data,
        signerWallet: flowData.ownerWallet as `0x${string}`,
      },
      recipient: userId as `0x${string}`,
    },
    { threadId: validThreadId },
  );

  await handler.sendMessage(
    channelId,
    `📤 **Step 3: Transfer Ownership**\n\n` +
      `Please approve the transaction to transfer **${flowData.fullName}** to \`${formatAddress(flowData.recipient as `0x${string}`)}\`.`,
    { threadId: validThreadId },
  );
}

/**
 * Handle Step 3 transaction response (Transfer Ownership)
 */
export async function handleSubdomainStep3Transaction(
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

  // Get flow
  const flowResult = await getActiveFlow(userId, originalThreadId);

  if (!flowResult.success || !isSubdomainFlow(flowResult.data)) {
    await handler.sendMessage(channelId, `❌ Subdomain flow not found.`, {
      threadId: validThreadId,
    });
    return;
  }

  const flow = flowResult.data;
  const flowData = flow.data;

  // Check if transaction was rejected
  if (!tx.txHash || tx.txHash === "" || tx.txHash === "0x") {
    await handler.sendMessage(
      channelId,
      `❌ **Transaction Rejected**\n\n` +
        `Ownership was not transferred.\n\n` +
        `Note: **${flowData.fullName}** was created and the address record was set.\n` +
        `Current owner: \`${formatAddress(flowData.ownerWallet as `0x${string}`)}\`\n\n` +
        `You can transfer ownership later using the ENS app.`,
      { threadId: validThreadId },
    );
    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Update flow and mark complete
  await updateFlowData(userId, originalThreadId, {
    step3TxHash: tx.txHash,
  });
  await updateFlowStatus(userId, originalThreadId, "complete");

  // Success!
  await handler.sendMessage(
    channelId,
    `🎉 **Subdomain Assignment Complete!**\n\n` +
      `**${flowData.fullName}** now:\n` +
      `• Points to: \`${flowData.resolveAddress}\`\n` +
      `• Owned by: \`${formatAddress(flowData.recipient as `0x${string}`)}\`\n\n` +
      `**Transaction Details:**\n` +
      `• Step 1: [Creation](https://etherscan.io/tx/${flowData.step1TxHash})\n\n` +
      `• Step 2: [Set Address](https://etherscan.io/tx/${flowData.step2TxHash})\n\n` +
      `• Step 3: [Transfer](https://etherscan.io/tx/${tx.txHash})\n\n` +
      `The subdomain is now active and ready to use! 🚀`,
    { threadId: validThreadId },
  );

  // Clean up
  await clearActiveFlow(userId, originalThreadId);
  await clearUserPendingCommand(userId);
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
  } else if (tx.requestId.startsWith("subdomain_step3:")) {
    await handleSubdomainStep3Transaction(handler, event, tx);
  } else {
    console.error("Unknown subdomain transaction requestId:", tx.requestId);
  }
}
