import {
  checkAvailability,
  checkExpiry,
  getHistory,
  getUserPorfolio,
} from "../../services/ens";
import { verifyOwnership } from "../../services/ens/utils";
import { checkAllEOABalances, filterEOAs, formatAddress } from "../../utils";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Format tool result for Claude
 */
function formatResult(data: unknown, displayMessage?: string): ToolResult {
  return {
    success: true,
    data,
    displayMessage,
  };
}

function formatError(error: string): ToolResult {
  return {
    success: false,
    error,
  };
}

// ============================================================
// CHECK AVAILABILITY
// ============================================================

export const checkAvailabilityTool: ToolDefinition = {
  name: "check_availability",
  description:
    "Check if one or more ENS names are available for registration. Returns availability status, current owner (if taken), and registration price.",
  parameters: {
    type: "object",
    properties: {
      names: {
        type: "array",
        description:
          "Array of ENS names to check, e.g. ['example.eth', 'test.eth']. Include .eth suffix.",
      },
    },
    required: ["names"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const names = params.names as string[];

    try {
      const results = await Promise.all(
        names.map(async (name) => {
          const result = await checkAvailability(name);
          if (!result.success) {
            return { name, error: result.error };
          }
          return result.data.values[0];
        }),
      );

      const available = results.filter((r: any) => r.isAvailable);
      const taken = results.filter((r: any) => !r.isAvailable && !r.error);

      let message = "";
      if (available.length > 0) {
        message += `✅ Available: ${available.map((r: any) => r.name).join(", ")}\n`;
      }
      if (taken.length > 0) {
        message += `❌ Taken: ${taken.map((r: any) => `${r.name} (owner: ${formatAddress(r.owner)})`).join(", ")}`;
      }

      return formatResult(results, message);
    } catch (error) {
      return formatError(
        `Failed to check availability: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// GET EXPIRY
// ============================================================

export const getExpiryTool: ToolDefinition = {
  name: "get_expiry",
  description:
    "Get the expiry date for an ENS name. Shows when it expires, days remaining, and grace period status.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to check expiry for, e.g. 'example.eth'",
      },
    },
    required: ["name"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;

    try {
      const result = await checkExpiry(name);

      if (!result.success) {
        return formatError(result.error || "Failed to get expiry");
      }

      if (!result.data) {
        return formatError("Failed to get expiry");
      }

      const expiry = result.data.values[0];

      if (expiry.error) {
        return formatError(expiry.error);
      }

      const message = expiry.expiryDate
        ? `📅 ${name} expires on ${expiry.expiryDate.toLocaleDateString(
            "en-US",
            {
              year: "numeric",
              month: "long",
              day: "numeric",
            },
          )} (${expiry.daysUntilExpiry} days remaining)`
        : `${name} does not have an expiry date`;

      return formatResult(expiry, message);
    } catch (error) {
      return formatError(
        `Failed to get expiry: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// GET PORTFOLIO
// ============================================================

export const getPortfolioTool: ToolDefinition = {
  name: "get_portfolio",
  description:
    "Get all ENS names owned by an address. If no address provided, checks all of the user's linked wallets.",
  parameters: {
    type: "object",
    properties: {
      address: {
        type: "string",
        description:
          "Optional: Specific Ethereum address to check. If not provided, checks user's wallets.",
      },
    },
    required: [],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const address = params.address as string | undefined;

    try {
      let addresses: `0x${string}`[] = [];

      if (address) {
        addresses = [address as `0x${string}`];
      } else {
        // Get user's linked wallets
        addresses = await filterEOAs(context.userId as `0x${string}`);
        if (addresses.length === 0) {
          return formatError(
            "No linked wallets found. Please connect a wallet to your Towns account.",
          );
        }
      }

      const results = await Promise.all(
        addresses.map(async (addr) => {
          const portfolio = await getUserPorfolio(addr);
          return { address: addr, portfolio };
        }),
      );

      const totalNames = results.reduce(
        (sum, r) => sum + (r.portfolio?.names?.length || 0),
        0,
      );

      let message = `📋 Found ${totalNames} ENS name(s) across ${addresses.length} wallet(s)`;

      if (totalNames > 0) {
        for (const { address, portfolio } of results) {
          if (portfolio?.names && portfolio.names.length > 0) {
            message += `\n\n**${formatAddress(address)}**: ${portfolio.names.map((n) => n.name).join(", ")}`;
          }
        }
      }

      return formatResult(results, message);
    } catch (error) {
      return formatError(
        `Failed to get portfolio: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// GET HISTORY
// ============================================================

export const getHistoryTool: ToolDefinition = {
  name: "get_history",
  description: "Get the ownership and registration history for an ENS name.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to get history for, e.g. 'example.eth'",
      },
    },
    required: ["name"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;

    try {
      const history = await getHistory(name);

      const message = `📜 History for ${name}: ${history.events.length || 0} registration events, ${history.events.filter((h) => h.type === "transferred")?.length || 0} transfers`;

      return formatResult(history, message);
    } catch (error) {
      return formatError(
        `Failed to get history: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// CHECK BALANCE
// ============================================================

export const checkBalanceTool: ToolDefinition = {
  name: "check_balance",
  description:
    "Check ETH balances on Ethereum Mainnet (L1) and Base (L2) for the user's wallets. Useful before transactions to ensure sufficient funds.",
  parameters: {
    type: "object",
    properties: {
      requiredAmount: {
        type: "string",
        description:
          "Optional: Required amount in wei to check if balance is sufficient",
      },
    },
    required: [],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const requiredAmount = params.requiredAmount
      ? BigInt(params.requiredAmount as string)
      : undefined;

    console.log(
      `[check_balance] Starting balance check for user: ${context.userId}`,
    );

    try {
      console.log(`[check_balance] Fetching linked wallets...`);
      const wallets = await filterEOAs(context.userId as `0x${string}`);
      console.log(`[check_balance] Found ${wallets.length} wallets`);

      if (wallets.length === 0) {
        return formatError(
          "No linked EOA wallets found. Please connect a wallet to your Towns account.",
        );
      }

      console.log(`[check_balance] Checking balances for wallets:`, wallets);
      const balances = await checkAllEOABalances(
        context.userId as `0x${string}`,
        requiredAmount, // This can be undefined - it's optional
      );
      console.log(`[check_balance] Balance check complete`);

      // Build message with FULL addresses (important for Claude to use correctly)
      let message = "💰 **Wallet Balances:**\n";
      for (const wallet of balances.wallets) {
        // Show full address - DO NOT abbreviate
        message += `\n**Wallet ${wallet.address}:**`;
        message += `\n  • Mainnet (L1): ${Number(wallet.l1BalanceEth).toFixed(6)} ETH`;
        message += `\n  • Base (L2): ${Number(wallet.l2BalanceEth).toFixed(6)} ETH`;
      }

      // Calculate totals
      const totalL1 = balances.wallets.reduce(
        (sum, w) => sum + parseFloat(w.l1BalanceEth),
        0,
      );
      const totalL2 = balances.wallets.reduce(
        (sum, w) => sum + parseFloat(w.l2BalanceEth),
        0,
      );
      message += `\n\n**Totals:** ${totalL1.toFixed(6)} ETH on Mainnet, ${totalL2.toFixed(6)} ETH on Base`;

      // Check if any wallet can bridge (has meaningful L2 balance)
      // Bridge minimum is usually ~0.002 ETH to be worthwhile
      const BRIDGE_MINIMUM = 0.002;
      const walletsWithBridgeableFunds = balances.wallets.filter(
        (w) => parseFloat(w.l2BalanceEth) >= BRIDGE_MINIMUM,
      );

      if (walletsWithBridgeableFunds.length > 0) {
        // Show FULL addresses for bridgeable wallets
        message += `\n\n💡 **Can bridge from Base:**`;
        for (const w of walletsWithBridgeableFunds) {
          message += `\n  • ${w.address} has ${Number(w.l2BalanceEth).toFixed(4)} ETH on Base`;
        }
      }

      // If requiredAmount specified, add specific guidance
      if (requiredAmount) {
        const requiredEth = Number(requiredAmount) / 1e18;
        const hasEnoughL1 = balances.wallets.some(
          (w) => w.l1Balance >= requiredAmount,
        );

        if (hasEnoughL1) {
          const bestWallet = balances.wallets.find(
            (w) => w.l1Balance >= requiredAmount,
          );
          message += `\n\n✅ Sufficient balance on Mainnet. Use wallet: ${bestWallet?.address}`;
        } else {
          // Check if can bridge - need requiredAmount + ~0.001 ETH for bridge fees + gas
          const bridgeTotal = requiredAmount + BigInt(Math.floor(0.001 * 1e18)); // Add 0.001 ETH buffer
          const bridgeWallet = balances.wallets.find(
            (w) => w.l2Balance >= bridgeTotal,
          );

          if (bridgeWallet) {
            message += `\n\n⚠️ L1 insufficient. **Bridge from wallet: ${bridgeWallet.address}** (has ${bridgeWallet.l2BalanceEth} ETH on Base)`;
          } else {
            message += `\n\n❌ Insufficient balance. Need ${requiredEth.toFixed(4)} ETH + gas on Mainnet.`;
          }
        }
      }

      // Serialize BigInt values to strings for JSON compatibility
      // Include full addresses in canBridgeFrom for Claude to use
      const serializedBalances = {
        ...balances,
        wallets: balances.wallets.map((w) => ({
          address: w.address, // Full address
          l1Balance: w.l1Balance.toString(),
          l1BalanceEth: w.l1BalanceEth,
          l2Balance: w.l2Balance.toString(),
          l2BalanceEth: w.l2BalanceEth,
          totalBalance: w.totalBalance.toString(),
          totalBalanceEth: w.totalBalanceEth,
        })),
        // Explicit list of full addresses that can bridge
        canBridgeFrom: walletsWithBridgeableFunds.map((w) => w.address),
        // Best wallet to use for bridging (full address)
        recommendedBridgeWallet:
          walletsWithBridgeableFunds.length > 0
            ? walletsWithBridgeableFunds.sort(
                (a, b) =>
                  parseFloat(b.l2BalanceEth) - parseFloat(a.l2BalanceEth),
              )[0].address
            : null,
      };

      return formatResult(serializedBalances, message);
    } catch (error) {
      console.error(`[check_balance] ERROR:`, error);
      return formatError(
        `Failed to check balance: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// VERIFY OWNERSHIP
// ============================================================

export const verifyOwnershipTool: ToolDefinition = {
  name: "verify_ownership",
  description:
    "Verify if the current user owns a specific ENS name. Checks all linked wallets.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to verify ownership of, e.g. 'example.eth'",
      },
    },
    required: ["name"],
  },
  execute: async (params, context): Promise<ToolResult> => {
    const name = params.name as string;

    try {
      const wallets = await filterEOAs(context.userId as `0x${string}`);

      if (wallets.length === 0) {
        return formatError("No linked wallets found.");
      }

      const result = await verifyOwnership(name, wallets);

      if (result.owned) {
        return formatResult(
          result,
          `✅ You own ${name} (via ${formatAddress(result.ownerWallet!)})`,
        );
      } else {
        const ownerInfo = result.actualOwner
          ? `Current owner: ${formatAddress(result.actualOwner)}`
          : "Name may not be registered";
        return formatResult(result, `❌ You don't own ${name}. ${ownerInfo}`);
      }
    } catch (error) {
      return formatError(
        `Failed to verify ownership: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// GET REGISTRATION PRICE
// ============================================================

export const getRegistrationPriceTool: ToolDefinition = {
  name: "get_registration_price",
  description:
    "Get the price to register an ENS name for a specified number of years.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to get price for, e.g. 'example.eth'",
      },
      years: {
        type: "number",
        description: "Number of years to register for (1-10)",
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
      // Import dynamically to avoid circular deps
      const { estimateRegistrationCost } = await import("../../services/ens");

      const estimate = await estimateRegistrationCost({
        names: [name],
        durationYears: years,
      });

      const ethPrice = 2500; // Approximate USD price
      const usdCost = (Number(estimate.grandTotalEth) * ethPrice).toFixed(2);

      const message =
        `💰 Registration cost for ${name} (${years} year${years > 1 ? "s" : ""}):\n` +
        `• Name: ${estimate.totalDomainCostEth} ETH\n` +
        `• Total (with buffer): ${estimate.grandTotalEth} ETH (~$${usdCost})`;

      return formatResult(estimate, message);
    } catch (error) {
      return formatError(
        `Failed to get price: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// GET RENEWAL PRICE
// ============================================================

export const getRenewalPriceTool: ToolDefinition = {
  name: "get_renewal_price",
  description:
    "Get the price to renew an ENS name for a specified number of years.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "ENS name to get renewal price for, e.g. 'example.eth'",
      },
      years: {
        type: "number",
        description: "Number of years to renew for (1-10)",
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
      const { getRenewService } =
        await import("../../services/ens/renew/renew");

      const renewService = getRenewService();
      const price = await renewService.getRenewalPrice(name, years);

      const ethPrice = 2500;
      const usdCost = (Number(price.totalCostEth) * ethPrice).toFixed(2);

      const message =
        `💰 Renewal cost for ${name} (${years} year${years > 1 ? "s" : ""}):\n` +
        `• Cost: ${price.totalCostEth} ETH (~$${usdCost})`;

      return formatResult(price, message);
    } catch (error) {
      return formatError(
        `Failed to get renewal price: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  },
};

// ============================================================
// EXPORT ALL READ TOOLS
// ============================================================

export const readTools: ToolDefinition[] = [
  checkAvailabilityTool,
  getExpiryTool,
  getPortfolioTool,
  getHistoryTool,
  checkBalanceTool,
  verifyOwnershipTool,
  getRegistrationPriceTool,
  getRenewalPriceTool,
];
