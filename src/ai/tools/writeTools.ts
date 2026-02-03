// src/agent/tools/writeTools.ts

import { prepareRegistration } from "../../services/ens";
import { getRenewService } from "../../services/ens/renew/renew";
import { getSubdomainService } from "../../services/ens/subdomain/subdomain";
import { filterEOAs, formatAddress } from "../../utils";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Format tool result
 */
function formatResult(
  data: unknown,
  displayMessage?: string,
  options?: {
    requiresUserAction?: boolean;
    userAction?: {
      type: "sign_transaction" | "confirm";
      payload: unknown;
    };
  },
): ToolResult {
  return {
    success: true,
    data,
    displayMessage,
    ...options,
  };
}

function formatError(error: string): ToolResult {
  return {
    success: false,
    error,
  };
}

// ============================================================
// PREPARE REGISTRATION
// ============================================================

export const prepareRegistrationTool: ToolDefinition = {
  name: "prepare_registration",
  description: `Prepare and send an ENS name registration commit transaction. This is a 2-step commit-reveal process:
1. Commit transaction (reserves the name secretly) - SENT BY THIS TOOL
2. Wait 60 seconds
3. Register transaction (completes registration) - sent after commit succeeds

Call this after confirming availability and sufficient balance. This will send the commit transaction to the user for signing.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to register, e.g. 'example.eth'",
      },
      years: {
        type: "number",
        description: "Number of years to register for (1-10)",
      },
      walletAddress: {
        type: "string",
        description: "Wallet address to use for registration and as owner",
      },
    },
    required: ["name", "years", "walletAddress"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const years = params.years as number;
    const walletAddress = params.walletAddress as `0x${string}`;

    if (years < 1 || years > 10) {
      return formatError("Duration must be between 1 and 10 years.");
    }

    try {
      // prepareRegistration returns PendingRegistration which contains:
      // - commitment: RegistrationCommitment (name, secret, commitment hash, owner, durationSec, domainPriceWei)
      // - costs: RegistrationCostEstimate
      // - grandTotalWei, grandTotalEth, etc.
      const registration = await prepareRegistration({
        name,
        owner: walletAddress,
        durationYears: years,
      });

      const ethPrice = 2500;
      const usdCost = (Number(registration.grandTotalEth) * ethPrice).toFixed(
        2,
      );

      // Build the commit transaction using viem
      const { encodeFunctionData } = await import("viem");

      // ETH Registrar Controller address (mainnet)
      const ETH_REGISTRAR_CONTROLLER =
        "0x253553366Da8546fC250F225fe3d25d0C782303b" as `0x${string}`;

      // Encode the commit function call
      const commitData = encodeFunctionData({
        abi: [
          {
            name: "commit",
            type: "function",
            inputs: [{ name: "commitment", type: "bytes32" }],
            outputs: [],
          },
        ],
        functionName: "commit",
        args: [registration.commitment.commitment],
      });

      // Generate safe tool ID for Anthropic
      const toolId = `tx_registration_commit_${generateSafeId()}`;
      const requestId = `registration_commit:${context.userId}:${context.threadId}`;

      // Store the registration data and pending action
      const { setSessionPendingAction } = await import("../sessions");

      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_registration",
          toolId: toolId,
          expectedAction: "registration_commit",
        },
        {
          type: "registration",
          step: 1,
          totalSteps: 2,
          data: {
            name,
            years,
            walletAddress,
            secret: registration.commitment.secret,
            commitmentHash: registration.commitment.commitment,
            durationSec: registration.commitment.durationSec.toString(),
            domainPriceWei: registration.commitment.domainPriceWei.toString(),
            grandTotalEth: registration.grandTotalEth,
          },
        },
      );

      // Send message explaining the process
      await context.sendMessage(
        `📝 **Registration for ${name}**\n\n` +
          `• Duration: ${years} year${years > 1 ? "s" : ""}\n` +
          `• Cost: ${registration.grandTotalEth} ETH (~$${usdCost})\n` +
          `• Wallet: ${formatAddress(walletAddress)}\n\n` +
          `**Step 1 of 2:** Sign the commit transaction to reserve the name.\n` +
          `After this, we'll wait 60 seconds, then complete the registration.\n\n` +
          `_If the UI shows "Transaction Failed" after signing, reply "done" - it usually succeeds._`,
      );

      // Actually send the transaction request to Towns
      await context.sendTransaction({
        id: requestId,
        title: `Commit: Register ${name}`,
        chainId: "1",
        to: ETH_REGISTRAR_CONTROLLER,
        data: commitData,
        value: "0x0",
        signerWallet: walletAddress,
      });

      return formatResult(
        {
          name,
          years,
          walletAddress,
          toolId,
          requestId,
          status: "awaiting_commit_signature",
        },
        `Transaction request sent! Waiting for user to sign the commit transaction...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              step: "commit",
              actionType: "registration_commit",
              name,
              walletAddress,
            },
          },
        },
      );
    } catch (error) {
      console.error("[prepare_registration] Error:", error);
      return formatError(
        `Failed to prepare registration: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

/**
 * Generate a safe ID that matches Anthropic's tool_use_id pattern: ^[a-zA-Z0-9_-]+$
 */
function generateSafeId(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ============================================================
// PREPARE RENEWAL
// ============================================================

export const prepareRenewalTool: ToolDefinition = {
  name: "prepare_renewal",
  description:
    "Prepare and send an ENS name renewal transaction. Only the owner can renew. Call after verifying ownership.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to renew, e.g. 'example.eth'",
      },
      years: {
        type: "number",
        description: "Number of years to extend (1-10)",
      },
    },
    required: ["name", "years"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const years = params.years as number;

    if (years < 1 || years > 10) {
      return formatError("Duration must be between 1 and 10 years.");
    }

    try {
      const wallets = await filterEOAs(context.userId as `0x${string}`);

      if (wallets.length === 0) {
        return formatError("No linked wallets found.");
      }

      const renewService = getRenewService();
      const prepResult = await renewService.prepareRenewal({
        name,
        durationYears: years,
        userWallets: wallets,
      });

      if (!prepResult.success || !prepResult.data) {
        return formatError(prepResult.error || "Failed to prepare renewal");
      }

      const renewal = prepResult.data;
      const tx = renewService.buildRenewalTransaction({
        labelName: renewal.labelName,
        durationSeconds: renewal.durationSeconds,
        valueWei: renewal.recommendedValueWei,
      });

      const ethPrice = 2500;
      const usdCost = (Number(renewal.totalCostEth) * ethPrice).toFixed(2);

      const formatDate = (date: Date) =>
        date.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });

      // Generate safe tool ID
      const toolId = `tx_renewal_${generateSafeId()}`;
      const requestId = `renewal:${context.userId}:${context.threadId}`;

      // Store pending action
      const { setSessionPendingAction } = await import("../sessions");

      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_renewal",
          toolId: toolId,
          expectedAction: "renewal",
        },
        {
          type: "renewal",
          step: 1,
          totalSteps: 1,
          data: {
            name,
            years,
            ownerWallet: renewal.ownerWallet,
            currentExpiry: renewal.currentExpiry.toISOString(),
            newExpiry: renewal.newExpiry.toISOString(),
          },
        },
      );

      // Send message
      await context.sendMessage(
        `📝 **Renewal for ${name}**\n\n` +
          `• Duration: ${years} year${years > 1 ? "s" : ""}\n` +
          `• Cost: ${renewal.totalCostEth} ETH (~$${usdCost})\n` +
          `• Wallet: ${formatAddress(renewal.ownerWallet)}\n\n` +
          `📅 **Expiry Dates:**\n` +
          `• Current: ${formatDate(renewal.currentExpiry)}\n` +
          `• After renewal: ${formatDate(renewal.newExpiry)}\n\n` +
          `_If the UI shows "Transaction Failed" after signing, reply "done" - it usually succeeds._`,
      );

      // Actually send the transaction request
      await context.sendTransaction({
        id: requestId,
        title: `Renew ${name} for ${years} year${years > 1 ? "s" : ""}`,
        chainId: "1",
        to: tx.to,
        data: tx.data,
        value: tx.valueHex,
        signerWallet: renewal.ownerWallet,
      });

      return formatResult(
        {
          name,
          years,
          toolId,
          requestId,
          status: "awaiting_signature",
        },
        `Transaction request sent! Waiting for user to sign...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "renewal",
              name,
            },
          },
        },
      );
    } catch (error) {
      console.error("[prepare_renewal] Error:", error);
      return formatError(
        `Failed to prepare renewal: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// PREPARE TRANSFER
// ============================================================

export const prepareTransferTool: ToolDefinition = {
  name: "prepare_transfer",
  description:
    "Prepare and send an ENS name transfer transaction. This action is irreversible. Call after verifying ownership and getting user confirmation. Pass ownerWallet and isWrapped from verify_ownership to avoid redundant lookups.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to transfer, e.g. 'example.eth'",
      },
      toAddress: {
        type: "string",
        description: "Recipient's Ethereum address (0x...)",
      },
      ownerWallet: {
        type: "string",
        description:
          "The wallet that owns the domain (from verify_ownership result)",
      },
      isWrapped: {
        type: "boolean",
        description:
          "Whether the domain is wrapped (from verify_ownership result). REQUIRED - must pass true or false.",
      },
    },
    required: ["name", "toAddress", "ownerWallet", "isWrapped"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const toAddress = params.toAddress as `0x${string}`;
    const ownerWallet = params.ownerWallet as `0x${string}`;
    let isWrapped = params.isWrapped as boolean | undefined;

    // ALWAYS verify on-chain to ensure we use the correct contract
    // This prevents issues where the passed value might be stale or incorrect
    const { getActualOwner } = await import("../../services/ens/utils");
    const ownerInfo = await getActualOwner(name);

    console.log(`[prepare_transfer] Name: ${name}`);
    console.log(`[prepare_transfer] Param isWrapped: ${isWrapped}`);
    console.log(`[prepare_transfer] On-chain isWrapped: ${ownerInfo.isWrapped}`);
    console.log(`[prepare_transfer] On-chain owner: ${ownerInfo.owner}`);

    // Use the on-chain value - it's the source of truth
    if (isWrapped !== ownerInfo.isWrapped) {
      console.log(
        `[prepare_transfer] WARNING: Param isWrapped (${isWrapped}) differs from on-chain (${ownerInfo.isWrapped}). Using on-chain value.`,
      );
    }
    isWrapped = ownerInfo.isWrapped;

    try {
      // Import transfer service
      const { getTransferService } =
        await import("../../services/ens/transfer/transfer");
      const transferService = getTransferService();

      // Build the transfer transaction using the provided owner info
      // This avoids redundant RPC calls since we already verified ownership
      const tx = await transferService.buildTransferTransaction({
        name,
        newOwnerAddress: toAddress,
        currentOwner: ownerWallet!,
        isWrapped: isWrapped,
      });

      // Generate safe tool ID for Anthropic
      const toolId = `tx_transfer_${generateSafeId()}`;
      const requestId = `transfer:${context.userId}:${context.threadId}`;

      // Store pending action
      const { setSessionPendingAction } = await import("../sessions");

      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_transfer",
          toolId: toolId,
          expectedAction: "transfer",
        },
        {
          type: "transfer",
          step: 1,
          totalSteps: 1,
          data: {
            name,
            fromAddress: ownerWallet,
            toAddress,
            isWrapped,
          },
        },
      );

      // Send message
      await context.sendMessage(
        `📝 **Transfer ${name}**\n\n` +
          `• From: ${formatAddress(ownerWallet)}\n` +
          `• To: ${formatAddress(toAddress)}\n\n` +
          `⚠️ **Warning:** This action cannot be undone!\n\n` +
          `_If the UI shows "Transaction Failed" after signing, reply "done" - the transfer usually succeeds._`,
      );

      // Actually send the transaction request
      // Transfers don't require ETH value, so use "0x0"
      await context.sendTransaction({
        id: requestId,
        title: `Transfer ${name}`,
        chainId: "1",
        to: tx.to,
        data: tx.data,
        value: "0x0", // Transfers don't send ETH
        signerWallet: ownerWallet,
      });

      return formatResult(
        {
          name,
          fromAddress: ownerWallet,
          toAddress,
          toolId,
          requestId,
          status: "awaiting_signature",
        },
        `Transaction request sent! Waiting for user to sign...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "transfer",
              name,
              fromAddress: ownerWallet,
              toAddress,
            },
          },
        },
      );
    } catch (error) {
      console.error("[prepare_transfer] Error:", error);
      return formatError(
        `Failed to prepare transfer: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// PREPARE SUBDOMAIN
// ============================================================

export const prepareSubdomainTool: ToolDefinition = {
  name: "prepare_subdomain",
  description: `Prepare subdomain creation. Requires ownership of parent domain.
If recipient is different from owner, requires 3 transactions:
1. Create subdomain
2. Set address record
3. Transfer ownership
If recipient is the owner, only 2 transactions needed.`,
  parameters: {
    type: "object",
    properties: {
      parentName: {
        type: "string",
        description: "Parent domain, e.g. 'myname.eth'",
      },
      label: {
        type: "string",
        description: "Subdomain label, e.g. 'blog' for blog.myname.eth",
      },
      resolveAddress: {
        type: "string",
        description: "Address the subdomain should point to and be owned by",
      },
    },
    required: ["parentName", "label", "resolveAddress"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const parentName = params.parentName as string;
    const label = params.label as string;
    const resolveAddress = params.resolveAddress as `0x${string}`;

    try {
      const wallets = await filterEOAs(context.userId as `0x${string}`);

      if (wallets.length === 0) {
        return formatError("No linked wallets found.");
      }

      const subdomainService = getSubdomainService();

      // Verify parent ownership
      const ownership = await subdomainService.verifyParentOwnership(
        parentName,
        wallets,
      );

      if (!ownership.owned) {
        return formatError(
          ownership.error ||
            `You don't own ${parentName}. Only the owner can create subdomains.`,
        );
      }

      const fullName = `${label}.${parentName}`;

      // Check if subdomain already exists
      const exists = await subdomainService.subnameExists(fullName);
      if (exists) {
        return formatError(`${fullName} already exists.`);
      }

      // Determine number of steps
      const recipientIsOwner =
        ownership.ownerWallet!.toLowerCase() === resolveAddress.toLowerCase();
      const totalSteps = recipientIsOwner ? 2 : 3;

      // Build step 1 transaction
      const step1Tx = subdomainService.buildStep1_CreateSubdomain({
        fullSubname: fullName,
        caller: ownership.ownerWallet!,
        isWrapped: ownership.isWrapped,
      });

      // Generate request ID
      const requestId = `subdomain_step1:${context.userId}:${context.threadId}`;
      const toolId = `tx_subdomain_step1_${generateSafeId()}`;

      // Store pending action
      const { setSessionPendingAction } = await import("../sessions");
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_subdomain",
          toolId,
          expectedAction: "subdomain_step1",
        },
        {
          type: "subdomain",
          step: 1,
          totalSteps,
          data: {
            fullName,
            parentName,
            label,
            resolveAddress,
            ownerWallet: ownership.ownerWallet,
            isWrapped: ownership.isWrapped,
          },
        },
      );

      // Send message explaining the process
      await context.sendMessage(
        `📝 **Creating subdomain ${fullName}**\n\n` +
          `• Points to: ${formatAddress(resolveAddress)}\n` +
          `• Steps required: ${totalSteps}\n\n` +
          `**Step 1 of ${totalSteps}:** Sign to create the subdomain.`,
      );

      // ACTUALLY SEND THE TRANSACTION REQUEST
      await context.sendTransaction({
        id: requestId,
        title: `Create Subdomain: ${fullName} (Step 1/${totalSteps})`,
        chainId: "1",
        to: step1Tx.to,
        data: step1Tx.data,
        value: step1Tx.value
          ? `0x${BigInt(step1Tx.value).toString(16)}`
          : "0x0",
        signerWallet: ownership.ownerWallet!,
      });

      return formatResult(
        {
          requestId,
          toolId,
          fullName,
          parentName,
          label,
          resolveAddress,
          ownerWallet: ownership.ownerWallet,
          isWrapped: ownership.isWrapped,
          totalSteps,
          status: "awaiting_step1_signature",
        },
        `Transaction sent. Waiting for signature...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "subdomain_step1",
              fullName,
              step: 1,
              totalSteps,
            },
          },
        },
      );
    } catch (error) {
      return formatError(
        `Failed to prepare subdomain: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// COMPLETE SUBDOMAIN STEP 2 (Set Address Record)
// ============================================================

export const completeSubdomainStep2Tool: ToolDefinition = {
  name: "complete_subdomain_step2",
  description: `Complete subdomain step 2 (set address record) after step 1 transaction is confirmed.
This tool reads the stored subdomain data from the session and sends the step 2 transaction.
Call this AFTER step 1 transaction is signed and confirmed.`,
  parameters: {
    type: "object",
    properties: {
      fullName: {
        type: "string",
        description: "Full subdomain name (e.g., 'blog.myname.eth')",
      },
    },
    required: ["fullName"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const fullName = params.fullName as string;

    try {
      // Get stored subdomain data from session
      const { getSession, setSessionPendingAction } =
        await import("../sessions");
      const session = await getSession(context.userId, context.threadId);

      if (!session?.currentAction?.data) {
        return formatError(
          "No pending subdomain operation found. Please start over with prepare_subdomain.",
        );
      }

      const subData = session.currentAction.data;

      if (subData.fullName !== fullName) {
        return formatError(
          `Subdomain mismatch. Expected ${subData.fullName}, got ${fullName}.`,
        );
      }

      const ownerWallet = subData.ownerWallet as `0x${string}`;
      const resolveAddress = subData.resolveAddress as `0x${string}`;
      const isWrapped = subData.isWrapped as boolean;
      const totalSteps = subData.totalSteps as number;

      console.log(`[complete_subdomain_step2] Setting address for ${fullName}`);
      console.log(
        `[complete_subdomain_step2] Wallet: ${ownerWallet}, Resolve to: ${resolveAddress}`,
      );

      // Build step 2 transaction
      const subdomainService = getSubdomainService();
      const step2Tx = subdomainService.buildStep2_SetAddress({
        fullSubname: fullName,
        // caller: ownerWallet,
        resolveAddress: resolveAddress,
        // isWrapped,
      });

      const requestId = `subdomain_step2:${context.userId}:${context.threadId}`;
      const toolId = `tx_subdomain_step2_${generateSafeId()}`;

      // Update session state
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "complete_subdomain_step2",
          toolId,
          expectedAction: "subdomain_step2",
        },
        {
          type: "subdomain",
          step: 2,
          totalSteps,
          data: subData,
        },
      );

      await context.sendMessage(
        `**Step 2 of ${totalSteps}:** Sign to set the address record for ${fullName}.`,
      );

      await context.sendTransaction({
        id: requestId,
        title: `Set Address: ${fullName} (Step 2/${totalSteps})`,
        chainId: "1",
        to: step2Tx.to,
        data: step2Tx.data,
        value: step2Tx.value
          ? `0x${BigInt(step2Tx.value).toString(16)}`
          : "0x0",
        signerWallet: ownerWallet,
      });

      return formatResult(
        {
          requestId,
          toolId,
          fullName,
          step: 2,
          totalSteps,
          status: "awaiting_step2_signature",
        },
        `Transaction sent. Waiting for signature...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "subdomain_step2",
              fullName,
              step: 2,
              totalSteps,
            },
          },
        },
      );
    } catch (error) {
      console.error("[complete_subdomain_step2] Error:", error);
      return formatError(
        `Failed to complete step 2: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// COMPLETE SUBDOMAIN STEP 3 (Transfer Ownership - if needed)
// ============================================================

export const completeSubdomainStep3Tool: ToolDefinition = {
  name: "complete_subdomain_step3",
  description: `Complete subdomain step 3 (transfer ownership) after step 2 is confirmed.
This is only needed if the recipient is different from the parent domain owner.
Call this AFTER step 2 transaction is signed and confirmed.`,
  parameters: {
    type: "object",
    properties: {
      fullName: {
        type: "string",
        description: "Full subdomain name (e.g., 'blog.myname.eth')",
      },
    },
    required: ["fullName"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const fullName = params.fullName as string;

    try {
      const { getSession, setSessionPendingAction } =
        await import("../sessions");
      const session = await getSession(context.userId, context.threadId);

      if (!session?.currentAction?.data) {
        return formatError(
          "No pending subdomain operation found. Please start over.",
        );
      }

      const subData = session.currentAction.data;

      if (subData.fullName !== fullName) {
        return formatError(
          `Subdomain mismatch. Expected ${subData.fullName}, got ${fullName}.`,
        );
      }

      const totalSteps = subData.totalSteps as number;

      if (totalSteps !== 3) {
        return formatError(
          `Step 3 not needed for this subdomain (only ${totalSteps} steps required).`,
        );
      }

      const ownerWallet = subData.ownerWallet as `0x${string}`;
      const resolveAddress = subData.resolveAddress as `0x${string}`;
      const isWrapped = subData.isWrapped as boolean;

      console.log(
        `[complete_subdomain_step3] Transferring ${fullName} to ${resolveAddress}`,
      );

      // Build step 3 transaction
      const subdomainService = getSubdomainService();
      const step3Tx = subdomainService.buildStep3_TransferOwnership({
        fullSubname: fullName,
        caller: ownerWallet,
        recipient: resolveAddress,
        isWrapped,
      });

      const requestId = `subdomain_step3:${context.userId}:${context.threadId}`;
      const toolId = `tx_subdomain_step3_${generateSafeId()}`;

      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "complete_subdomain_step3",
          toolId,
          expectedAction: "subdomain_step3",
        },
        {
          type: "subdomain",
          step: 3,
          totalSteps: 3,
          data: subData,
        },
      );

      await context.sendMessage(
        `**Step 3 of 3:** Sign to transfer ownership of ${fullName} to ${formatAddress(resolveAddress)}.`,
      );

      await context.sendTransaction({
        id: requestId,
        title: `Transfer Ownership: ${fullName} (Step 3/3)`,
        chainId: "1",
        to: step3Tx.to,
        data: step3Tx.data,
        value: step3Tx.value
          ? `0x${BigInt(step3Tx.value).toString(16)}`
          : "0x0",
        signerWallet: ownerWallet,
      });

      return formatResult(
        {
          requestId,
          toolId,
          fullName,
          step: 3,
          totalSteps: 3,
          status: "awaiting_step3_signature",
        },
        `Transaction sent. Waiting for signature...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "subdomain_step3",
              fullName,
              step: 3,
              totalSteps: 3,
            },
          },
        },
      );
    } catch (error) {
      console.error("[complete_subdomain_step3] Error:", error);
      return formatError(
        `Failed to complete step 3: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// PREPARE BRIDGE
// ============================================================

export const prepareBridgeTool: ToolDefinition = {
  name: "prepare_bridge",
  description:
    "Prepare a bridge transaction to move ETH from Base (L2) to Ethereum Mainnet (L1). Use when L1 balance is insufficient for ENS operations. The walletAddress MUST be a full 42-character address from check_balance results.",
  parameters: {
    type: "object",
    properties: {
      amountEth: {
        type: "string",
        description:
          "Amount of ETH needed on Mainnet (the tool will calculate fees on top), e.g. '0.05'",
      },
      walletAddress: {
        type: "string",
        description:
          "FULL wallet address (42 chars, e.g. 0x230908A09525e80978Fb822Ec7F1a2F3cfB29A3b) from check_balance results. Do NOT abbreviate.",
      },
    },
    required: ["amountEth", "walletAddress"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const amountEth = params.amountEth as string;
    let walletAddress = params.walletAddress as `0x${string}`;

    console.log(`[prepare_bridge] Starting bridge preparation`);
    console.log(`[prepare_bridge] amountEth: ${amountEth}`);
    console.log(`[prepare_bridge] walletAddress: ${walletAddress}`);

    try {
      // Validate wallet address format
      if (
        !walletAddress ||
        walletAddress.length !== 42 ||
        !walletAddress.startsWith("0x")
      ) {
        console.error(
          `[prepare_bridge] Invalid wallet address format: ${walletAddress}`,
        );
        return formatError(
          `Invalid wallet address format. Please use the full 42-character address from check_balance results (e.g., 0x230908A09525e80978Fb822Ec7F1a2F3cfB29A3b), not an abbreviated version.`,
        );
      }

      // Import utilities
      const { getBridgeQuoteAndTx } =
        await import("../../services/bridge/bridge");
      const { CHAIN_IDS } =
        await import("../../services/bridge/bridgeConstants");
      const { checkBalance } = await import("../../utils");
      const { formatEther, parseEther } = await import("viem");

      // Verify this is one of the user's wallets
      const userWallets = await filterEOAs(context.userId as `0x${string}`);
      console.log(`[prepare_bridge] User's wallets:`, userWallets);

      const isValidWallet = userWallets.some(
        (w) => w.toLowerCase() === walletAddress.toLowerCase(),
      );

      if (!isValidWallet) {
        console.error(
          `[prepare_bridge] Wallet not in user's linked wallets: ${walletAddress}`,
        );

        // Try to find the best wallet automatically
        const { checkAllEOABalances } = await import("../../utils");
        const balances = await checkAllEOABalances(
          context.userId as `0x${string}`,
        );
        const bestWallet = balances.wallets
          .filter(
            (w) => parseFloat(w.l2BalanceEth) >= parseFloat(amountEth) + 0.001,
          )
          .sort(
            (a, b) => parseFloat(b.l2BalanceEth) - parseFloat(a.l2BalanceEth),
          )[0];

        if (bestWallet) {
          console.log(
            `[prepare_bridge] Auto-selecting wallet with most L2 balance: ${bestWallet.address}`,
          );
          walletAddress = bestWallet.address as `0x${string}`;
        } else {
          return formatError(
            `Wallet address ${walletAddress} is not one of your linked wallets. Your wallets are: ${userWallets.join(", ")}`,
          );
        }
      }

      const amountNeededWei = BigInt(Math.floor(parseFloat(amountEth) * 1e18));
      console.log(`[prepare_bridge] amountNeededWei: ${amountNeededWei}`);

      // Check Base balance first
      const baseBalanceCheck = await checkBalance(
        walletAddress,
        CHAIN_IDS.BASE,
      );
      console.log(
        `[prepare_bridge] Base balance: ${baseBalanceCheck.balanceEth} ETH`,
      );

      console.log(`[prepare_bridge] Getting initial bridge quote...`);
      // Get initial quote to understand fee structure
      const initialQuote = await getBridgeQuoteAndTx(
        amountNeededWei,
        walletAddress,
        CHAIN_IDS.BASE,
        CHAIN_IDS.MAINNET,
      );

      // Calculate fee percentage from initial quote
      const initialOutput = BigInt(initialQuote.quote.outputAmount || "0");
      const feeAmount = amountNeededWei - initialOutput;

      // Calculate amount to bridge: we need output >= amountNeededWei
      const feeWithBuffer = (feeAmount * 110n) / 100n;
      const amountToBridge = amountNeededWei + feeWithBuffer;

      // Get actual quote with correct input amount
      const { quote, swapTx } = await getBridgeQuoteAndTx(
        amountToBridge,
        walletAddress,
        CHAIN_IDS.BASE,
        CHAIN_IDS.MAINNET,
      );

      // Check if amount is too low
      if (quote.isAmountTooLow) {
        return formatError(
          `Amount too low for bridging. Minimum: ${formatEther(BigInt(quote.limits.minDeposit))} ETH`,
        );
      }

      const bridgeFeeWei = BigInt(quote.totalRelayFee.total);
      const outputAmount = BigInt(quote.outputAmount || "0");

      // Validate output amount covers needed amount
      if (outputAmount < amountNeededWei) {
        return formatError(
          `Bridge fees too high. After fees of ${formatEther(bridgeFeeWei)} ETH, ` +
            `you would only receive ${formatEther(outputAmount)} ETH on Mainnet, ` +
            `which is less than the ${amountEth} ETH needed.`,
        );
      }

      // Estimate gas needed on Base for bridge transaction
      const baseGasEstimate = parseEther("0.001");
      const totalNeededOnBase = amountToBridge + baseGasEstimate;

      // Check if user has enough on Base
      if (baseBalanceCheck.balance < totalNeededOnBase) {
        const shortfall = totalNeededOnBase - baseBalanceCheck.balance;
        return formatError(
          `Insufficient funds on Base.\n` +
            `Need: ${formatEther(totalNeededOnBase)} ETH (${formatEther(amountToBridge)} to bridge + gas)\n` +
            `Have: ${baseBalanceCheck.balanceEth} ETH\n` +
            `Shortfall: ${formatEther(shortfall)} ETH`,
        );
      }

      // Generate request ID for tracking
      const requestId = `bridge:${context.userId}:${context.threadId}:${Date.now()}`;
      const toolId = `tx_bridge_${generateSafeId()}`;

      // Get current mainnet balance for verification later
      const mainnetBalanceCheck = await checkBalance(walletAddress, CHAIN_IDS.MAINNET);
      const previousMainnetBalanceEth = mainnetBalanceCheck.balanceEth;

      // Store pending action so bot knows to resume when user signs
      const { setSessionPendingAction } = await import("../sessions");
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_bridge",
          toolId: toolId,
          expectedAction: "bridge",
        },
        {
          type: "bridge",
          step: 1,
          totalSteps: 1,
          data: {
            walletAddress,
            amountToBridgeWei: amountToBridge.toString(),
            amountToBridgeEth: formatEther(amountToBridge),
            outputAmountEth: formatEther(outputAmount),
            estimatedFillTimeSec: quote.estimatedFillTimeSec,
            previousMainnetBalanceEth,
          },
        },
      );

      // Send message to user
      await context.sendMessage(
        `🌉 **Bridge Ready**\n\n` +
          `• Sending: **${formatEther(amountToBridge)} ETH** from Base\n` +
          `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
          `• You'll receive: ~${formatEther(outputAmount)} ETH on Mainnet\n` +
          `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
          `⚠️ **Important:** The Towns UI may show "Transaction Failed" - ignore this! The bridge usually succeeds.\n\n` +
          `**After signing, wait ~${Math.ceil(quote.estimatedFillTimeSec / 60)} minute(s), then reply "done" and I'll verify your balance and continue.**`,
      );

      // ACTUALLY SEND THE TRANSACTION REQUEST
      // Convert value to hex format (Towns Protocol expects hex, not decimal string)
      const valueHex = `0x${BigInt(swapTx.value).toString(16)}`;

      await context.sendTransaction({
        id: requestId,
        title: `Bridge ${formatEther(amountToBridge)} ETH to Mainnet`,
        chainId: CHAIN_IDS.BASE.toString(), // Bridge tx is on Base
        to: swapTx.to,
        data: swapTx.data,
        value: valueHex,
        signerWallet: walletAddress,
      });

      return formatResult(
        {
          requestId,
          amountNeededEth: amountEth,
          amountToBridgeEth: formatEther(amountToBridge),
          amountToBridgeWei: amountToBridge.toString(),
          outputAmountEth: formatEther(outputAmount),
          bridgeFeeEth: formatEther(bridgeFeeWei),
          estimatedTime: quote.estimatedFillTimeSec,
          walletAddress,
          status: "awaiting_signature",
        },
        `Transaction request sent. Waiting for signature...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "bridge",
              requestId,
              amountToBridgeWei: amountToBridge.toString(),
              walletAddress,
            },
          },
        },
      );
    } catch (error) {
      console.error("Bridge preparation error:", error);
      return formatError(
        `Failed to prepare bridge: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// COMPLETE REGISTRATION (Step 2 - after commit and wait)
// ============================================================

export const completeRegistrationTool: ToolDefinition = {
  name: "complete_registration",
  description: `Complete the ENS registration after the commit transaction and 60-second wait.
This tool reads the stored registration data from the session and sends the register transaction.
Call this AFTER:
1. prepare_registration (commit tx) was signed
2. 60-second wait completed
DO NOT call send_transaction directly - use this tool instead to ensure correct wallet is used.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name being registered (e.g., 'example.eth')",
      },
    },
    required: ["name"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;

    try {
      // Get stored registration data from session
      const { getSession } = await import("../sessions");
      const session = await getSession(context.userId, context.threadId);

      if (!session || session.currentAction?.type !== "registration") {
        return formatError(
          "No pending registration found. Please start the registration process again with prepare_registration.",
        );
      }

      const regData = session.currentAction?.data;

      if (!regData) {
        return formatError(
          "No pending registration found. Please start the registration process again with prepare_registration.",
        );
      }

      // Validate the stored data
      if (regData.name !== name) {
        return formatError(
          `Registration mismatch. Expected ${regData.name}, got ${name}. Please start over.`,
        );
      }

      const walletAddress = regData.walletAddress as `0x${string}`;
      const secret = regData.secret as `0x${string}`;
      const durationSec = BigInt(regData.durationSec as string);
      const domainPriceWei = BigInt(regData.domainPriceWei as string);

      console.log(
        `[complete_registration] Completing registration for ${name}`,
      );
      console.log(`[complete_registration] Wallet: ${walletAddress}`);
      console.log(`[complete_registration] Duration: ${durationSec}s`);
      console.log(`[complete_registration] Value: ${domainPriceWei} wei`);

      // Build the register transaction
      const { encodeFunctionData, toHex, formatEther } = await import("viem");

      const ETH_REGISTRAR_CONTROLLER =
        "0x253553366Da8546fC250F225fe3d25d0C782303b" as `0x${string}`;
      const PUBLIC_RESOLVER =
        "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" as `0x${string}`;

      // Strip .eth suffix for the register call
      const label = name.replace(/\.eth$/, "");

      // Encode the register function call
      const registerData = encodeFunctionData({
        abi: [
          {
            name: "register",
            type: "function",
            inputs: [
              { name: "name", type: "string" },
              { name: "owner", type: "address" },
              { name: "duration", type: "uint256" },
              { name: "secret", type: "bytes32" },
              { name: "resolver", type: "address" },
              { name: "data", type: "bytes[]" },
              { name: "reverseRecord", type: "bool" },
              { name: "ownerControlledFuses", type: "uint16" },
            ],
            outputs: [],
          },
        ],
        functionName: "register",
        args: [
          label,
          walletAddress,
          durationSec,
          secret,
          PUBLIC_RESOLVER,
          [], // No resolver data
          false, // reverseRecord - MUST match prepareRegistration commitment
          0, // No fuses
        ],
      });

      // Convert value to hex - only send domain price, not gas estimates
      const valueHex = toHex(domainPriceWei);

      const requestId = `registration_register:${context.userId}:${context.threadId}`;
      const toolId = `tx_registration_register_${generateSafeId()}`;

      // Store pending action
      const { setSessionPendingAction } = await import("../sessions");
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "complete_registration",
          toolId,
          expectedAction: "registration_register",
        },
        {
          type: "registration",
          step: 2,
          totalSteps: 2,
          data: regData,
        },
      );

      // Send message
      const domainPriceEth = formatEther(domainPriceWei);
      await context.sendMessage(
        `📝 **Final Registration Step for ${name}**\n\n` +
          `• Wallet: ${formatAddress(walletAddress)}\n` +
          `• Cost: ${domainPriceEth} ETH\n\n` +
          `Sign the transaction to complete your registration!\n\n` +
          `_If the UI shows "Transaction Failed" after signing, reply "done" - it usually succeeds._`,
      );

      // Send the transaction with the CORRECT wallet from stored data
      await context.sendTransaction({
        id: requestId,
        title: `Complete Registration: ${name}`,
        chainId: "1",
        to: ETH_REGISTRAR_CONTROLLER,
        data: registerData,
        value: valueHex,
        signerWallet: walletAddress,
      });

      return formatResult(
        {
          name,
          walletAddress,
          requestId,
          toolId,
          status: "awaiting_register_signature",
        },
        `Register transaction sent. Waiting for signature...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              step: "register",
              actionType: "registration_register",
              name,
              walletAddress,
            },
          },
        },
      );
    } catch (error) {
      console.error("[complete_registration] Error:", error);
      return formatError(
        `Failed to complete registration: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// PREPARE SET PRIMARY NAME
// ============================================================

export const prepareSetPrimaryTool: ToolDefinition = {
  name: "prepare_set_primary",
  description: `Set the primary ENS name for a wallet. This is the name that will be displayed when apps look up the wallet address.
The user must own the ENS name they want to set as primary.
Call verify_ownership first to confirm the user owns the name.`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to set as primary, e.g. 'example.eth'",
      },
      ownerWallet: {
        type: "string",
        description:
          "The wallet that owns the domain and will have this as primary name (from verify_ownership result)",
      },
    },
    required: ["name", "ownerWallet"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const ownerWallet = params.ownerWallet as `0x${string}`;

    try {
      const { encodeFunctionData } = await import("viem");
      const { ENS_CONTRACTS, REVERSE_REGISTRAR_ABI } =
        await import("../../services/ens/constants");

      // Build the setName transaction
      const setNameData = encodeFunctionData({
        abi: REVERSE_REGISTRAR_ABI,
        functionName: "setName",
        args: [name],
      });

      // Generate request ID
      const requestId = `setprimary:${context.userId}:${context.threadId}`;
      const toolId = `tx_setprimary_${generateSafeId()}`;

      // Store pending action
      const { setSessionPendingAction } = await import("../sessions");
      await setSessionPendingAction(
        context.userId,
        context.threadId,
        {
          toolName: "prepare_set_primary",
          toolId,
          expectedAction: "setprimary",
        },
        {
          type: "setprimary" as any,
          step: 1,
          totalSteps: 1,
          data: {
            name,
            ownerWallet,
          },
        },
      );

      // Send message
      await context.sendMessage(
        `📝 **Set Primary Name**\n\n` +
          `• Name: ${name}\n` +
          `• Wallet: ${formatAddress(ownerWallet)}\n\n` +
          `After signing, your wallet address will display as **${name}** in apps and wallets.\n\n` +
          `_If the UI shows "Transaction Failed" after signing, reply "done" - it usually succeeds._`,
      );

      // Send the transaction
      await context.sendTransaction({
        id: requestId,
        title: `Set ${name} as Primary`,
        chainId: "1",
        to: ENS_CONTRACTS.REVERSE_REGISTRAR,
        data: setNameData,
        value: "0x0",
        signerWallet: ownerWallet,
      });

      return formatResult(
        {
          name,
          ownerWallet,
          requestId,
          toolId,
          status: "awaiting_signature",
        },
        `Transaction request sent! Waiting for user to sign...`,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "setprimary",
              name,
              ownerWallet,
            },
          },
        },
      );
    } catch (error) {
      console.error("[prepare_set_primary] Error:", error);
      return formatError(
        `Failed to prepare set primary: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// EXPORT ALL WRITE TOOLS
// ============================================================

export const writeTools: ToolDefinition[] = [
  prepareRegistrationTool,
  completeRegistrationTool,
  prepareRenewalTool,
  prepareTransferTool,
  prepareSubdomainTool,
  completeSubdomainStep2Tool,
  completeSubdomainStep3Tool,
  prepareBridgeTool,
  prepareSetPrimaryTool,
];
