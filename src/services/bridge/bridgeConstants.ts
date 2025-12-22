// Across Protocol Bridge Constants

// Across SpokePool Contract Addresses
export const ACROSS_SPOKE_POOL = {
  BASE: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64" as const, // Base SpokePool
  MAINNET: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5" as const, // Ethereum SpokePool
} as const;

// WETH Token Addresses
export const WETH_ADDRESS = {
  BASE: "0x4200000000000000000000000000000000000006" as const, // WETH on Base
  MAINNET: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const, // WETH on Mainnet
} as const;

// Chain IDs
export const CHAIN_IDS = {
  BASE: 8453,
  MAINNET: 1,
} as const;

// Bridge Configuration
export const BRIDGE_CONFIG = {
  // Safety buffer for gas costs (5% extra)
  GAS_BUFFER_PERCENTAGE: 5,

  // Maximum time to wait for bridge completion (5 minutes)
  MAX_BRIDGE_WAIT_MS: 5 * 60 * 1000,

  // Polling interval for checking bridge status (5 seconds)
  POLL_INTERVAL_MS: 5 * 1000,

  // Estimated bridge time in seconds
  ESTIMATED_BRIDGE_TIME_SECONDS: 60,

  // Minimum bridge amount in ETH (to ensure profitability for relayers)
  MIN_BRIDGE_AMOUNT_ETH: "0.001",
} as const;

// Across API Endpoint
export const ACROSS_API_URL = "https://app.across.to/api" as const;
