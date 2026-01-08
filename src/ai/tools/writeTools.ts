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
  description: `Prepare an ENS name registration. This is a 2-step commit-reveal process:
1. Commit transaction (reserves the name secretly)
2. Wait 60 seconds
3. Register transaction (completes registration)

Call this after confirming availability and sufficient balance.`,
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

      const message =
        `📝 Registration prepared for **${name}**:\n\n` +
        `• Duration: ${years} year${years > 1 ? "s" : ""}\n` +
        `• Cost: ${registration.grandTotalEth} ETH (~$${usdCost})\n` +
        `• Wallet: ${formatAddress(walletAddress)}\n\n` +
        `**Process:**\n` +
        `1. Sign commit transaction (reserves the name)\n` +
        `2. Wait 60 seconds (required by ENS)\n` +
        `3. Sign register transaction (completes registration)\n\n` +
        `Ready to proceed with Step 1?`;

      // The commitment hash is in registration.commitment.commitment
      // The actual commit transaction needs to be built by the caller
      // using the commitment data
      return formatResult(
        {
          name,
          years,
          walletAddress,
          registration: {
            ...registration,
            // Convert BigInt to string for JSON serialization
            grandTotalWei: registration.grandTotalWei.toString(),
            totalDomainCostWei: registration.totalDomainCostWei.toString(),
            commitment: {
              ...registration.commitment,
              durationSec: registration.commitment.durationSec.toString(),
              domainPriceWei: registration.commitment.domainPriceWei.toString(),
            },
            costs: {
              ...registration.costs,
              commitGasWei: registration.costs.commitGasWei.toString(),
              registerGasWei: registration.costs.registerGasWei.toString(),
            },
          },
        },
        message,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              step: "commit",
              actionType: "registration_commit",
              name,
              walletAddress,
              // Include the commitment hash for building the transaction
              commitmentHash: registration.commitment.commitment,
              secret: registration.commitment.secret,
            },
          },
        },
      );
    } catch (error) {
      return formatError(
        `Failed to prepare registration: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// PREPARE RENEWAL
// ============================================================

export const prepareRenewalTool: ToolDefinition = {
  name: "prepare_renewal",
  description:
    "Prepare an ENS name renewal transaction. Only the owner can renew. Call after verifying ownership.",
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

      const message =
        `📝 Renewal prepared for **${name}**:\n\n` +
        `• Duration: ${years} year${years > 1 ? "s" : ""}\n` +
        `• Cost: ${renewal.totalCostEth} ETH (~$${usdCost})\n` +
        `• Wallet: ${formatAddress(renewal.ownerWallet)}\n\n` +
        `📅 **Expiry Dates:**\n` +
        `• Current: ${formatDate(renewal.currentExpiry)}\n` +
        `• After renewal: ${formatDate(renewal.newExpiry)}\n\n` +
        `Ready to sign the renewal transaction?`;

      return formatResult(
        {
          name,
          years,
          renewal,
          tx: {
            to: tx.to,
            data: tx.data,
            value: tx.valueHex,
            signerWallet: renewal.ownerWallet,
          },
        },
        message,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "renewal",
              name,
              renewal,
              tx,
            },
          },
        },
      );
    } catch (error) {
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
    "Prepare an ENS name transfer to a new owner. This action is irreversible. Call after verifying ownership.",
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
    },
    required: ["name", "toAddress"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;
    const toAddress = params.toAddress as `0x${string}`;

    try {
      const wallets = await filterEOAs(context.userId as `0x${string}`);

      if (wallets.length === 0) {
        return formatError("No linked wallets found.");
      }

      // Verify ownership
      const ownership = await verifyOwnership(name, wallets);

      if (!ownership.owned) {
        return formatError(
          ownership.error ||
            `You don't own ${name}. Only the owner can transfer.`,
        );
      }

      // Import transfer service
      const { getTransferService } =
        await import("../../services/ens/transfer/transfer");
      const transferService = getTransferService();

      const tx = await transferService.buildTransferTransaction({
        name,
        newOwnerAddress: toAddress,
        currentOwner: ownership.ownerWallet!,
        isWrapped: ownership.isWrapped,
      });

      const message =
        `📝 Transfer prepared for **${name}**:\n\n` +
        `• From: ${formatAddress(ownership.ownerWallet!)}\n` +
        `• To: ${formatAddress(toAddress)}\n\n` +
        `⚠️ **Warning:** This action cannot be undone. The recipient will become the new owner.\n\n` +
        `Ready to sign the transfer transaction?`;

      return formatResult(
        {
          name,
          fromAddress: ownership.ownerWallet,
          toAddress,
          isWrapped: ownership.isWrapped,
          tx,
        },
        message,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "transfer",
              name,
              fromAddress: ownership.ownerWallet,
              toAddress,
              tx,
            },
          },
        },
      );
    } catch (error) {
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
    "Prepare a bridge transaction to move ETH from Base (L2) to Ethereum Mainnet (L1). Use when L1 balance is insufficient for ENS operations. Handles fee calculation and validation.",
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
        description: "Wallet address to bridge from/to",
      },
    },
    required: ["amountEth", "walletAddress"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const amountEth = params.amountEth as string;
    const walletAddress = params.walletAddress as `0x${string}`;

    try {
      // Import bridge utilities
      const { getBridgeQuoteAndTx } =
        await import("../../services/bridge/bridge");
      const { CHAIN_IDS } =
        await import("../../services/bridge/bridgeConstants");
      const { checkBalance } = await import("../../utils");
      const { formatEther, parseEther } = await import("viem");

      const amountNeededWei = BigInt(Math.floor(parseFloat(amountEth) * 1e18));

      // Check Base balance first
      const baseBalanceCheck = await checkBalance(
        walletAddress,
        CHAIN_IDS.BASE,
      );

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

      const message =
        `🌉 **Bridge Ready**\n\n` +
        `**You need:** ${amountEth} ETH on Mainnet\n\n` +
        `**Bridge Details:**\n` +
        `• Sending: ${formatEther(amountToBridge)} ETH from Base\n` +
        `• Bridge fee: ~${formatEther(bridgeFeeWei)} ETH\n` +
        `• You'll receive: ~${formatEther(outputAmount)} ETH on Mainnet\n` +
        `• Estimated time: ~${quote.estimatedFillTimeSec} seconds\n\n` +
        `⚠️ **Note:** Domain availability may change during bridging.\n\n` +
        `Ready to sign the bridge transaction?`;

      return formatResult(
        {
          amountNeededEth: amountEth,
          amountToBridgeEth: formatEther(amountToBridge),
          amountToBridgeWei: amountToBridge.toString(),
          outputAmountEth: formatEther(outputAmount),
          bridgeFeeEth: formatEther(bridgeFeeWei),
          estimatedTime: quote.estimatedFillTimeSec,
          walletAddress,
          tx: {
            to: swapTx.to as `0x${string}`,
            data: swapTx.data as `0x${string}`,
            value: swapTx.value,
            chainId: CHAIN_IDS.BASE.toString(),
          },
        },
        message,
        {
          requiresUserAction: true,
          userAction: {
            type: "sign_transaction",
            payload: {
              actionType: "bridge",
              amountToBridgeWei: amountToBridge.toString(),
              walletAddress,
              tx: {
                to: swapTx.to,
                data: swapTx.data,
                value: swapTx.value,
                chainId: CHAIN_IDS.BASE.toString(),
              },
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
