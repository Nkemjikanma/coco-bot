import { createPublicClient, formatEther, http, parseEther } from "viem";
import { base, mainnet } from "viem/chains";
import {
	ACROSS_API_URL,
	ACROSS_SPOKE_POOL,
	BRIDGE_CONFIG,
	CHAIN_IDS,
	WETH_ADDRESS,
} from "./bridgeConstants";
import type {
	BalanceCheckResult,
	BridgeQuote,
	SwapApprovalResponse,
} from "./types";

// Create public clients for balance checking
const mainnetClient = createPublicClient({
	chain: mainnet,
	transport: http(process.env.MAINNET_RPC_URL),
});

const baseClient = createPublicClient({
	chain: base,
	transport: http(process.env.BASE_RPC_URL),
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
		console.log(`getBridgeQuoteAndTx: Starting`);
		console.log(`getBridgeQuoteAndTx: amount=${amount}`);
		console.log(`getBridgeQuoteAndTx: depositor=${depositor}`);
		console.log(
			`getBridgeQuoteAndTx: fromChainId=${fromChainId}, toChainId=${toChainId}`,
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
