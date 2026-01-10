// src/agent/tools/writeTools.ts

import {
  estimateRegistrationCost,
  prepareRegistration,
} from "../../services/ens";
import { getRenewService } from "../../services/ens/renew/renew";
import { getSubdomainService } from "../../services/ens/subdomain/subdomain";
import { verifyOwnership } from "../../services/ens/utils";
import { checkAllEOABalances, filterEOAs, formatAddress } from "../../utils";
import type { AgentContext, ToolDefinition, ToolResult } from "../types";

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
            grandTotalWei: registration.grandTotalWei.toString(),
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
          `After this, we'll wait 60 seconds, then complete the registration.`,
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
          `• After renewal: ${formatDate(renewal.newExpiry)}`,
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
    "Prepare and send an ENS name transfer transaction. This action is irreversible. Call after verifying ownership and getting user confirmation. Pass the ownerWallet from verify_ownership to avoid redundant lookups.",
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
          "Whether the domain is wrapped (from verify_ownership result)",
      },
    },
    required: ["name", "toAddress", "ownerWallet"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const toAddress = params.toAddress as `0x${string}`;
    const ownerWallet = params.ownerWallet as `0x${string}`;
    const isWrapped = params.isWrapped as boolean;

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
            isWrapped: isWrapped ?? true,
          },
        },
      );

      // Send message
      await context.sendMessage(
        `📝 **Transfer ${name}**\n\n` +
          `• From: ${formatAddress(ownerWallet)}\n` +
          `• To: ${formatAddress(toAddress)}\n\n` +
          `⚠️ **Warning:** This action cannot be undone!`,
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

      const message =
        `📝 Subdomain setup prepared for **${fullName}**:\n\n` +
        `• Parent: ${parentName}\n` +
        `• Points to: ${formatAddress(resolveAddress)}\n` +
        `• Owner after: ${formatAddress(resolveAddress)}\n` +
        `• Steps required: ${totalSteps}\n` +
        `• Estimated gas: $3-10\n\n` +
        `**Steps:**\n` +
        `1. Create subdomain\n` +
        `2. Set address record\n` +
        (totalSteps === 3 ? `3. Transfer ownership\n` : "") +
        `\nReady to start with Step 1?`;

      return formatResult(
        {
          fullName,
          parentName,
          label,
          resolveAddress,
          ownerWallet: ownership.ownerWallet,
          isWrapped: ownership.isWrapped,
          totalSteps,
          step1Tx,
        },
        message,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "subdomain_step1",
              fullName,
              step: 1,
              totalSteps,
              tx: step1Tx,
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

      // Send message to user
      await context.sendMessage(
        `🌉 **Bridge Ready**\n\n` +
          `• Sending: ${formatEther(amountToBridge)} ETH from Base\n` +
          `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
          `• You'll receive: ~${formatEther(outputAmount)} ETH on Mainnet\n` +
          `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
          `Sign the transaction to bridge your ETH.`,
      );

      await context.sendTransaction({
        id: requestId,
        title: `Bridge ${formatEther(amountToBridge)} ETH to Mainnet`,
        chainId: CHAIN_IDS.BASE.toString(),
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value,
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
// EXPORT ALL WRITE TOOLS
// ============================================================

export const writeTools: ToolDefinition[] = [
  prepareRegistrationTool,
  prepareRenewalTool,
  prepareTransferTool,
  prepareSubdomainTool,
  prepareBridgeTool,
];
