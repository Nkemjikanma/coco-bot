import {
  createPublicClient,
  http,
  formatEther,
  parseEther,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import { mainnet, base } from "viem/chains";
import { spokePoolAbiV3 } from "@across-protocol/app-sdk/dist/abis/SpokePool/v3.js";
import type {
  BalanceCheckResult,
  BridgeQuote,
  BridgeStatusResponse,
  SwapApprovalResponse,
} from "./types";
import {
  ACROSS_API_URL,
  WETH_ADDRESS,
  CHAIN_IDS,
  BRIDGE_CONFIG,
  ACROSS_SPOKE_POOL,
} from "./bridgeConstants";

// Create public clients for balance checking
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL),
});

const baseClient = createPublicClient({
  chain: base,
  transport: http(`https://mainnet.base.org`),
});

/**
 * Check ETH balance on a specific chain
 */
export async function checkBalance(
  address: `0x${string}`,
  chainId: number,
  requiredAmount?: bigint,
): Promise<BalanceCheckResult> {
  try {
    const client = chainId === CHAIN_IDS.MAINNET ? mainnetClient : baseClient;

    const balance = await client.getBalance({ address });
    const balanceEth = formatEther(balance);

    const sufficient = requiredAmount ? balance >= requiredAmount : true;
    const shortfall =
      requiredAmount && balance < requiredAmount
        ? requiredAmount - balance
        : undefined;

    return {
      address,
      chainId,
      balance,
      balanceEth,
      sufficient,
      required: requiredAmount,
      shortfall,
    };
  } catch (error) {
    console.error(`Error checking balance on chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Get bridge quote AND transaction data from Across Swap API
 */
export async function getBridgeQuoteAndTx(
  amount: bigint,
  depositor: `0x${string}`,
  fromChainId: number = CHAIN_IDS.BASE,
  toChainId: number = CHAIN_IDS.MAINNET,
): Promise<{
  quote: BridgeQuote;
  swapTx: {
    to: `0x${string}`;
    data: `0x${string}`;
    value: string;
  };
}> {
  try {
    console.log(
      `getBridgeQuoteAndTx: Fetching quote for ${formatEther(amount)} ETH`,
    );
    // Use WETH as input (will be wrapped from native ETH)
    const inputToken = WETH_ADDRESS.BASE;

    // Use zero address for native ETH output on destination
    const outputToken = "0x0000000000000000000000000000000000000000";

    const params = new URLSearchParams({
      tradeType: "exactInput",
      amount: amount.toString(),
      inputToken,
      outputToken,
      originChainId: fromChainId.toString(),
      destinationChainId: toChainId.toString(),
      depositor,
      recipient: depositor,
    });

    const response = await fetch(`${ACROSS_API_URL}/swap/approval?${params}`);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Swap API error:", errorText);
      throw new Error(`Across Swap API error: ${response.statusText}`);
    }

    const data: SwapApprovalResponse = await response.json();

    // Extract the transaction data
    const swapTx = {
      to: data.swapTx.to as `0x${string}`,
      data: data.swapTx.data as `0x${string}`,
      value: data.swapTx.value || amount.toString(),
    };

    // Calculate fee from input - output
    const inputAmount = BigInt(data.inputAmount);
    const outputAmount = BigInt(data.expectedOutputAmount);
    const feeTotal = inputAmount - outputAmount;

    const quote: BridgeQuote = {
      estimatedFillTimeSec: data.expectedFillTime || 60,
      totalRelayFee: {
        pct: data.fees?.totalRelay?.pct || "0",
        total: feeTotal.toString(),
      },
      estimatedTime: `${data.expectedFillTime || 60} seconds`,
      limits: {
        minDeposit: parseEther(BRIDGE_CONFIG.MIN_BRIDGE_AMOUNT_ETH).toString(),
        maxDeposit: "0",
        maxDepositInstant: "0",
        maxDepositShortDelay: "0",
      },
      isAmountTooLow: false,
      spokePoolAddress: ACROSS_SPOKE_POOL.BASE,
      outputAmount: data.expectedOutputAmount,
      minOutputAmount: data.minOutputAmount,
    };
    console.log(
      `getBridgeQuoteAndTx: Quote received - output: ${formatEther(BigInt(data.expectedOutputAmount))} ETH`,
    );
    return { quote, swapTx };
  } catch (error) {
    console.error("Error getting bridge quote from Swap API:", error);
    throw error;
  }
}

/**
 * Poll Across API to check bridge status
 */
export async function pollBridgeStatus(
  depositTxHash: string,
  callback: (status: BridgeStatusResponse) => void,
  maxWaitMs: number = BRIDGE_CONFIG.MAX_BRIDGE_WAIT_MS,
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = BRIDGE_CONFIG.POLL_INTERVAL_MS;

  const poll = async (): Promise<void> => {
    try {
      // Use depositTxnRef instead of depositId for easier tracking
      const response = await fetch(
        `${ACROSS_API_URL}/deposit/status?depositTxnRef=${depositTxHash}`,
      );

      if (!response.ok) {
        console.error(`Bridge status check failed: ${response.statusText}`);
        if (Date.now() - startTime < maxWaitMs) {
          setTimeout(poll, pollInterval);
        }
        return;
      }

      const data: BridgeStatusResponse = await response.json();

      if (data.status === "filled") {
        callback(data);
        return;
      }

      if (data.status === "expired") {
        callback(data);
        return;
      }

      // Still pending, continue polling
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollInterval);
      } else {
        callback({ status: "pending" });
      }
    } catch (error) {
      console.error("Error polling bridge status:", error);
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollInterval);
      }
    }
  };

  poll();
}

/**
 * Calculate the amount of ETH needed on Mainnet for ENS registration
 * Includes registration cost + estimated gas + buffer
 */
export function calculateRequiredMainnetETH(
  registrationCostWei: bigint,
  gasBufferPercentage: number = BRIDGE_CONFIG.GAS_BUFFER_PERCENTAGE,
): bigint {
  const estimatedGas = parseEther("0.01");
  const total = registrationCostWei + estimatedGas;
  const buffer = (total * BigInt(gasBufferPercentage)) / 100n;
  return total + buffer;
}

/**
 * Extract deposit ID from a bridge transaction receipt
 */
export async function extractDepositId(
  txHash: `0x${string}`,
  chainId: number,
): Promise<string | null> {
  try {
    const client = chainId === CHAIN_IDS.BASE ? baseClient : mainnetClient;
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    const parsedLogs = parseEventLogs({
      abi: spokePoolAbiV3,
      eventName: "V3FundsDeposited",
      logs: receipt.logs,
    });

    const depositEvent = parsedLogs?.[0];

    if (!depositEvent) {
      console.error("No V3FundsDeposited event found in transaction logs");
      return null;
    }

    return depositEvent.args.depositId.toString();
  } catch (error) {
    console.error("Error extracting deposit ID:", error);
    return null;
  }
}
