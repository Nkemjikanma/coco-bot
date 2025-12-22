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
 * Get a bridge quote from Across Protocol
 */
export async function getBridgeQuote(
  amount: bigint,
  fromChainId: number = CHAIN_IDS.BASE,
  toChainId: number = CHAIN_IDS.MAINNET,
): Promise<BridgeQuote> {
  try {
    const inputToken =
      fromChainId === CHAIN_IDS.BASE ? WETH_ADDRESS.BASE : WETH_ADDRESS.MAINNET;
    const outputToken =
      toChainId === CHAIN_IDS.MAINNET
        ? WETH_ADDRESS.MAINNET
        : WETH_ADDRESS.BASE;

    const params = new URLSearchParams({
      inputToken,
      outputToken,
      originChainId: fromChainId.toString(),
      destinationChainId: toChainId.toString(),
      amount: amount.toString(),
      skipAmountLimit: "false",
    });

    const response = await fetch(`${ACROSS_API_URL}/suggested-fees?${params}`);

    if (!response.ok) {
      throw new Error(`Across API error: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      estimatedFillTimeSec: data.estimatedFillTimeSec || 60,
      totalRelayFee: data.totalRelayFee || { pct: "0", total: "0" },
      estimatedTime: data.estimatedTime || "1 minute",
      limits: data.limits || {
        minDeposit: parseEther(BRIDGE_CONFIG.MIN_BRIDGE_AMOUNT_ETH).toString(),
        maxDeposit: "0",
        maxDepositInstant: "0",
        maxDepositShortDelay: "0",
      },
      isAmountTooLow: data.isAmountTooLow || false,
      spokePoolAddress:
        fromChainId === CHAIN_IDS.BASE
          ? ACROSS_SPOKE_POOL.BASE
          : ACROSS_SPOKE_POOL.MAINNET,
    };
  } catch (error) {
    console.error("Error getting bridge quote:", error);
    throw error;
  }
}

/**
 * Prepare bridge transaction data for Across Protocol
 * This creates the transaction data that the user needs to sign
 */
export function prepareBridgeTransaction(
  amount: bigint,
  recipient: `0x${string}`,
  outputAmount: bigint,
  fromChainId: number = CHAIN_IDS.BASE,
  toChainId: number = CHAIN_IDS.MAINNET,
): {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
} {
  // For native ETH bridging on Across, we use the SpokePool contract
  // The deposit function signature:
  // depositV3(
  //   address depositor,
  //   address recipient,
  //   address inputToken,
  //   address outputToken,
  //   uint256 inputAmount,
  //   uint256 outputAmount,
  //   uint256 destinationChainId,
  //   address exclusiveRelayer,
  //   uint32 quoteTimestamp,
  //   uint32 fillDeadline,
  //   uint32 exclusivityDeadline,
  //   bytes calldata message
  // )

  const spokePoolAddress =
    fromChainId === CHAIN_IDS.BASE
      ? ACROSS_SPOKE_POOL.BASE
      : ACROSS_SPOKE_POOL.MAINNET;

  const inputToken =
    fromChainId === CHAIN_IDS.BASE ? WETH_ADDRESS.BASE : WETH_ADDRESS.MAINNET;
  const outputToken =
    toChainId === CHAIN_IDS.MAINNET ? WETH_ADDRESS.MAINNET : WETH_ADDRESS.BASE;

  // Get current timestamp for the quote
  const quoteTimestamp = Math.floor(Date.now() / 1000);

  // Encode the depositV3 function call
  const data = encodeFunctionData({
    abi: spokePoolAbiV3,
    functionName: "depositV3",
    args: [
      recipient, // depositor (user's wallet)
      recipient, // recipient (same wallet on destination chain)
      inputToken, // inputToken (WETH on origin chain)
      outputToken, // outputToken (WETH on destination chain)
      amount, // inputAmount (amount to bridge)
      outputAmount, // outputAmount (amount after fees)
      BigInt(toChainId), // destinationChainId
      "0x0000000000000000000000000000000000000000" as `0x${string}`, // exclusiveRelayer (none)
      quoteTimestamp, // quoteTimestamp (current time)
      0, // fillDeadline (0 = no deadline)
      0, // exclusivityDeadline (0 = no exclusivity period)
      "0x" as `0x${string}`, // message (empty)
    ],
  });

  return {
    to: spokePoolAddress,
    value: amount.toString(),
    data,
  };
}

/**
 * Poll Across API to check bridge status
 */
export async function pollBridgeStatus(
  depositId: string,
  fromChainId: number,
  callback: (status: BridgeStatusResponse) => void,
  maxWaitMs: number = BRIDGE_CONFIG.MAX_BRIDGE_WAIT_MS,
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = BRIDGE_CONFIG.POLL_INTERVAL_MS;

  const poll = async (): Promise<void> => {
    try {
      const response = await fetch(
        `${ACROSS_API_URL}/deposit/status?originChainId=${fromChainId}&depositId=${depositId}`,
      );

      if (!response.ok) {
        console.error(`Bridge status check failed: ${response.statusText}`);
        // Continue polling even if one request fails
        if (Date.now() - startTime < maxWaitMs) {
          setTimeout(poll, pollInterval);
        }
        return;
      }

      const data: BridgeStatusResponse = await response.json();

      if (data.status === "filled") {
        // Bridge completed successfully
        callback(data);
        return;
      }

      if (data.status === "expired") {
        // Bridge failed/expired
        callback(data);
        return;
      }

      // Still pending, continue polling
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollInterval);
      } else {
        // Timeout reached
        callback({ status: "pending" });
      }
    } catch (error) {
      console.error("Error polling bridge status:", error);
      if (Date.now() - startTime < maxWaitMs) {
        setTimeout(poll, pollInterval);
      }
    }
  };

  // Start polling
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
  // Add estimated gas cost (rough estimate: 0.01 ETH for commit + register transactions)
  const estimatedGas = parseEther("0.01");

  // Add buffer for gas price volatility
  const total = registrationCostWei + estimatedGas;
  const buffer = (total * BigInt(gasBufferPercentage)) / 100n;

  return total + buffer;
}

/**
 * Extract deposit ID from a bridge transaction receipt
 * Decodes the V3FundsDeposited event to get the depositId
 */
export async function extractDepositId(
  txHash: `0x${string}`,
  chainId: number,
): Promise<string | null> {
  try {
    const client = chainId === CHAIN_IDS.BASE ? baseClient : mainnetClient;
    const receipt = await client.getTransactionReceipt({ hash: txHash });

    // Parse the V3FundsDeposited event from the transaction logs
    const parsedLogs = parseEventLogs({
      abi: spokePoolAbiV3,
      eventName: "V3FundsDeposited",
      logs: receipt.logs,
    });

    // Get the first (and should be only) V3FundsDeposited event
    const depositEvent = parsedLogs?.[0];

    if (!depositEvent) {
      console.error("No V3FundsDeposited event found in transaction logs");
      return null;
    }

    // Extract the depositId from the event args
    // Convert to string as the API expects a string parameter
    return depositEvent.args.depositId.toString();
  } catch (error) {
    console.error("Error extracting deposit ID:", error);
    return null;
  }
}
