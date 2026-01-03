import { BotHandler } from "@towns-protocol/bot";
import { SubdomainCommand } from "../types";
import { getSubdomainService } from "../services/ens/subdomain/subdomain";
import { filterEOAs, formatAddress } from "../utils";
import {
  getActiveFlow,
  setActiveFlow,
  updateFlowStatus,
  updateFlowData,
  clearActiveFlow,
  createSubdomainFlow,
  isSubdomainFlow,
  type SubdomainFlow,
  setUserPendingCommand,
  clearUserPendingCommand,
} from "../db";
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
  const { name, subdomain } = command;

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

    // Check if recipient is one of the user's wallets
    const isRecipientUser = userWallets.some(
      (w) => w.toLowerCase() === resolveAddress.toLowerCase(),
    );

    console.log(
      `handleSubdomainCommand: Recipient is user's wallet: ${isRecipientUser}`,
    );

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
      owner: resolveAddress,
      isWrapped,
    });

    const flow = createSubdomainFlow({
      userId,
      threadId,
      channelId,
      status: "step1_pending",
      data: {
        subdomain: label,
        domain: parent,
        fullName: fullSubname,
        recipient: resolveAddress,
        ownerWallet: ownerWallet,
        isWrapped: isWrapped,
        canDoStep2: canDoStep2,
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
          signerWallet: ownerWallet,
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

  // Extract threadId from requestId
  const parts = tx.requestId.split(":");
  const originalThreadId = parts[2];
  const validThreadId = event.threadId || originalThreadId || eventId;

  // Get flow from the unified flow store
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

  //  Update flow with step 1 tx hash
  await updateFlowData(userId, originalThreadId, {
    step1TxHash: tx.txHash,
  });

  // Check if we can proceed to Step 2
  if (!flowData.canDoStep2) {
    // Recipient is not the user - we're done!
    await updateFlowStatus(userId, originalThreadId, "complete");

    await handler.sendMessage(
      channelId,
      `🎉 **Subdomain Created!**\n\n` +
        `**${flowData.fullName}** has been created and is now owned by:\n` +
        `\`${flowData.recipient}\`\n\n` +
        `**Transaction:** \`${tx.txHash}\`\n\n` +
        `ℹ️ The new owner can set the address record and other configurations using the ENS app at [app.ens.domains](https://app.ens.domains).`,
      { threadId: validThreadId },
    );

    // Clean up flow
    await clearActiveFlow(userId, originalThreadId);
    await clearUserPendingCommand(userId);
    return;
  }

  // Proceed to Step 2
  await updateFlowStatus(userId, originalThreadId, "step1_complete");

  await handler.sendMessage(
    channelId,
    `✅ **Step 1 Complete!**\n\n` +
      `Subdomain created: **${flowData.fullName}**\n` +
      `Tx: \`${tx.txHash}\`\n\n` +
      `Now proceeding to Step 2: Set address record...`,
    { threadId: validThreadId },
  );

  // Build step 2 transaction - set the address record
  const subdomainNode = namehash(flowData.fullName) as `0x${string}`;

  const setAddrData = encodeFunctionData({
    abi: PUBLIC_RESOLVER_ABI,
    functionName: "setAddr",
    args: [subdomainNode, flowData.recipient as `0x${string}`],
  });

  // Update flow status
  await updateFlowStatus(userId, originalThreadId, "step2_pending");

  // Send second transaction request
  await handler.sendInteractionRequest(
    channelId,
    {
      type: "transaction",
      id: `subdomain_step2:${userId}:${originalThreadId}`,
      title: `Set Address: ${flowData.fullName}`,
      tx: {
        chainId: "1",
        to: ENS_CONTRACTS.PUBLIC_RESOLVER,
        value: "0",
        data: setAddrData,
        signerWallet: flowData.recipient,
      },
      recipient: userId as `0x${string}`,
    },
    { threadId: validThreadId },
  );

  await handler.sendMessage(
    channelId,
    `📤 **Step 2 of 2: Set Address Record**\n\n` +
      `Please approve the transaction to point **${flowData.fullName}** to \`${formatAddress(flowData.recipient)}\`.`,
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

  // Get flow from the unified flow store
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

  // Update flow and mark complete
  await updateFlowData(userId, originalThreadId, {
    step2TxHash: tx.txHash,
  });
  await updateFlowStatus(userId, originalThreadId, "complete");

  // Success!
  await handler.sendMessage(
    channelId,
    `🎉 **Subdomain Assignment Complete!**\n\n` +
      `**${flowData.fullName}** now points to:\n` +
      `\`${flowData.recipient}\`\n\n` +
      `**Transaction Details:**\n` +
      `• Step 1 (Create): \`${flowData.step1TxHash}\`\n` +
      `• Step 2 (Set Address): \`${tx.txHash}\`\n\n` +
      `The subdomain is now active and ready to use! 🚀`,
    { threadId: validThreadId },
  );

  // Clean up flow
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
  } else {
    console.error("Unknown subdomain transaction requestId:", tx.requestId);
  }
}
