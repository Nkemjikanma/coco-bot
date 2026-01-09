import { getSmartAccountFromUserId } from "@towns-protocol/bot";
import walletLinkAbi from "@towns-protocol/generated/dev/abis/WalletLink.abi";
import { createPublicClient, formatEther, http, isAddress } from "viem";
import { readContract } from "viem/actions";
import { base, mainnet } from "viem/chains";
import { bot } from "./bot";
import { type BalanceCheckResult, CHAIN_IDS } from "./services/bridge";
import type { EOAWalletCheckResult, WalletBalanceInfo } from "./types";

const ethereumClient = createPublicClient({
  chain: mainnet,
  transport: http(),
});

const baseClient = createPublicClient({
  chain: base,
  transport: http(process.env.BASE_RPC_URL),
});

/**
 * Shortens an Ethereum address for display
 * Example: 0x1234567890abcdef... -> 0x1234...cdef
 */
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Calculates days until a future date
 */
export function daysFromNow(date: Date): number {
  const now = new Date();
  const givenDate = new Date(date);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  return Math.floor((givenDate.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Formats ETH price to 4 decimal places
 */
export function formatPrice(priceEth: string): string {
  return Number(priceEth).toFixed(4);
}

/**
 * Formats a given date
 * @param date
 * @returns
 */
export function formatDate(date: Date | string | number | bigint): string {
  // Handle BigInt strings (Unix timestamp in seconds)
  if (typeof date === "string") {
    try {
      const timestamp = BigInt(date);
      const milliseconds = Number(timestamp) * 1000;
      return new Date(milliseconds).toDateString();
    } catch {
      return "Unknown date";
    }
  }

  // Handle BigInt directly
  if (typeof date === "bigint") {
    const milliseconds = Number(date) * 1000;
    return new Date(milliseconds).toDateString();
  }

  // Handle number (assume milliseconds if large, seconds if small)
  if (typeof date === "number") {
    const milliseconds = date > 1e12 ? date : date * 1000;
    return new Date(milliseconds).toDateString();
  }

  // Handle Date object
  return new Date(date).toDateString();
}

export function formatExpiryDate(expiryDate: string | Date): string {
  try {
    let date: Date;

    if (expiryDate instanceof Date) {
      date = expiryDate;
    } else {
      // Handle string timestamp (Unix seconds)
      const timestamp = BigInt(expiryDate);
      date = new Date(Number(timestamp) * 1000);
    }

    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown";
  }
}

export async function checkBalance(
  address: `0x${string}`,
  chainId: number,
  requiredAmount?: bigint,
): Promise<BalanceCheckResult> {
  try {
    const client = chainId === CHAIN_IDS.MAINNET ? ethereumClient : baseClient;

    const balance = await client.getBalance({ address });
    const ethBalance = formatEther(balance);

    const sufficient = requiredAmount ? balance >= requiredAmount : true;

    const shortfall =
      requiredAmount && balance <= requiredAmount
        ? requiredAmount - balance
        : undefined;

    return {
      address,
      chainId,
      balance,
      balanceEth: ethBalance,
      sufficient,
      required: requiredAmount,
      shortfall,
    };
  } catch (e) {
    console.error(`Error checking balance on chain ${chainId}:`, e);
    throw e;
  }
}

export async function getLinkedWallets(
  userId: `0x${string}`,
): Promise<`0x${string}`[]> {
  try {
    const walletLinkAddress =
      bot?.client.config.base.chainConfig.addresses.spaceFactory;

    const linkedWallets = (await readContract(bot.viem, {
      address: walletLinkAddress as `0x${string}`,
      abi: walletLinkAbi,
      functionName: "getWalletsByRootKey",
      args: [userId],
    })) as `0x${string}`[];

    return linkedWallets || [];
  } catch (e) {
    console.error("Error fetching linked wallets:", e);
    return [];
  }
}

export async function filterEOAs(userId: `0x${string}`) {
  const userTownWallet = await getSmartAccountFromUserId(bot, {
    userId: userId as `0x${string}`,
  });

  const linkedWallets = await getLinkedWallets(userId);

  const filtered = linkedWallets.filter((wallet) => wallet !== userTownWallet);

  return filtered;
}

/**
 * Check balances for all EOA wallets on both L1 and L2
 */
export async function checkAllEOABalances(
  userId: `0x${string}`,
  requiredAmount: bigint,
): Promise<EOAWalletCheckResult> {
  const eoas = await filterEOAs(userId);

  const walletBalances: WalletBalanceInfo[] = await Promise.all(
    eoas.map(async (address) => {
      const [l1Balance, l2Balance] = await Promise.all([
        checkBalance(address, CHAIN_IDS.MAINNET),
        checkBalance(address, CHAIN_IDS.BASE),
      ]);

      const totalBalance = l1Balance.balance + l2Balance.balance;

      return {
        address,
        l1Balance: l1Balance.balance,
        l1BalanceEth: l1Balance.balanceEth,
        l2Balance: l2Balance.balance,
        l2BalanceEth: l2Balance.balanceEth,
        totalBalance,
        totalBalanceEth: formatEther(totalBalance),
      };
    }),
  );

  // Sort by L1 balance (descending) - prefer wallets with L1 funds
  const sortedByL1 = [...walletBalances].sort((a, b) =>
    Number(b.l1Balance - a.l1Balance),
  );

  // Sort by L2 balance (descending) - for bridge candidates
  const sortedByL2 = [...walletBalances].sort((a, b) =>
    Number(b.l2Balance - a.l2Balance),
  );

  // Find wallet with sufficient L1 balance
  const walletWithSufficientL1 = sortedByL1.find(
    (w) => w.l1Balance >= requiredAmount,
  );

  // Find wallet with sufficient L2 balance for bridging
  // Add buffer for bridge fees (~5%)
  const bridgeBuffer = (requiredAmount * 105n) / 100n;
  const walletWithSufficientL2 = sortedByL2.find(
    (w) => w.l2Balance >= bridgeBuffer,
  );

  return {
    wallets: walletBalances,
    hasWalletWithSufficientL1: !!walletWithSufficientL1,
    hasWalletWithSufficientL2ForBridge: !!walletWithSufficientL2,
    bestWalletForL1: walletWithSufficientL1 || null,
    bestWalletForBridge: walletWithSufficientL2 || null,
  };
}

/**
 * Format wallet balance info for display
 */
export function formatWalletBalanceInfo(wallet: WalletBalanceInfo): string {
  return (
    `${formatAddress(wallet.address)}\n` +
    `  • Mainnet: ${Number(wallet.l1BalanceEth).toFixed(4)} ETH\n` +
    `  • Base: ${Number(wallet.l2BalanceEth).toFixed(4)} ETH`
  );
}

/**
 * Format all wallet balances for display
 */
export function formatAllWalletBalances(
  wallets: WalletBalanceInfo[],
  requiredAmount: bigint,
): string {
  if (wallets.length === 0) {
    return "No connected EOA wallets found.";
  }

  const requiredEth = formatEther(requiredAmount);

  const walletLines = wallets
    .map((w, i) => {
      const l1Sufficient = w.l1Balance >= requiredAmount;
      const l2Sufficient = w.l2Balance >= requiredAmount;
      const status = l1Sufficient
        ? "✅ Ready for L1"
        : l2Sufficient
          ? "🌉 Can bridge from Base"
          : "⚠️ Insufficient";

      return (
        `**${i + 1}. ${formatAddress(w.address)}** ${status}\n` +
        `   Mainnet: ${Number(w.l1BalanceEth).toFixed(4)} ETH | Base: ${Number(w.l2BalanceEth).toFixed(4)} ETH`
      );
    })
    .join("\n\n");

  return `**Connected Wallets** (need ~${Number(requiredEth).toFixed(4)} ETH)\n\n${walletLines}`;
}

export function extractRecipientAddress(content: string): `0x${string}` | null {
  // First, try to find address after intent keywords
  const intentPattern =
    /(?:to|for|recipient|assign to)[:\s]+(0x[a-fA-F0-9]{40})/i;
  const intentMatch = content.match(intentPattern);

  if (intentMatch && intentMatch[1] && isAddress(intentMatch[1])) {
    return intentMatch[1] as `0x${string}`;
  }

  // Fallback: any address (current behavior)
  const anyAddress = content.match(/0x[a-fA-F0-9]{40}/i);
  return anyAddress && isAddress(anyAddress[0])
    ? (anyAddress[0] as `0x${string}`)
    : null;
}

export const PORTFOLIO_SELF_KEYWORDS = [
  "my wallets",
  "my portfolio",
  "my ens",
  "my names",
  "my domains",
  "what do i own",
  "what do i have",
  "show me my",
  "find in my",
];
