// ENS Contract Addresses on Ethereum Mainnet
export const ENS_CONTRACTS = {
	REGISTRAR_CONTROLLER: "0x253553366Da8546fC250F225fe3d25d0C782303b" as const,
	BASE_REGISTRAR: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85" as const,
	ENS_REGISTRY: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const,
	ENS_NAMEWRAPPER: "0xD4416b13d2b3a9aBae7AcdBB3092D31d512a2C71" as const,
	PUBLIC_RESOLVER: "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63" as const,
	REVERSE_REGISTRAR: "0xa58E81fe9b61B5c3fE2AFD33CF304c454AbFc7Cb" as const,
	// Mainnet ENS Subgraph endpoint (legacy endpoint - free, no API key required)
	SUBGRAPH_URL:
		"https://api.thegraph.com/subgraphs/name/ensdomains/ens" as const,
} as const;

export const SEPOLIA_ENS_CONFIG = {
	REGISTRAR_CONTROLLER: "0xFED6a969AaA60E4961FCD3EBF1A2e8913ac65B72" as const,
	BASE_REGISTRAR: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85" as const,
	ENS_REGISTRY: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const,
	PUBLIC_RESOLVER: "0x8FADE66B79cC9f707aB26799354482EB93a5B7dD" as const,
	REVERSE_REGISTRAR: "0xA0a1AbcDAe1a2a4A2B6F8638e4f1b4D0d5F5e7E8" as const,

	SUBGRAPH: {
		LEGACY:
			"https://api.studio.thegraph.com/query/49574/ens-sepolia/version/latest" as const,
	} as const,
};

// NameWrapper contract address
export const NAME_WRAPPER_ADDRESS =
	"0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";

export const SUBGRAPH_API_KEY = process.env.SUBGRAPH;
export const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;

export const ENS_SUBGRAPH = {
	LEGACY: "https://api.thegraph.com/subgraphs/name/ensdomains/ens" as const,
	KEY: `https://gateway-arbitrum.network.thegraph.com/api/${SUBGRAPH_API_KEY}/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH` as const,
} as const;

// Time Constants
export const TIME = {
	SECONDS_PER_YEAR: 31557600n, // 365.25 days in seconds
	MS_PER_DAY: 1000 * 60 * 60 * 24,
	GRACE_PERIOD_DAYS: 90, // ENS grace period after expiration
	GRACE_PERIOD_SECONDS: 90 * 24 * 60 * 60, // 90 days in seconds
} as const;

export const REGISTRATION = {
	MIN_COMMITMENT_AGE: 60, // Minimum 60 seconds between commit and register
	MAX_COMMITMENT_AGE: 86400, // Maximum 24 hours between commit and register
	DEFAULT_DURATION_YEARS: 1, // Default registration duration
	CHAIN_ID: "1", // Ethereum Mainnet
} as const;

// Validation Constants
export const ENS_VALIDATION = {
	MIN_LENGTH: 3,
	SUFFIX: ".eth",
} as const;

// ABIs
export const CONTROLLER_ABI = [
	{
		name: "available",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "name", type: "string" }],
		outputs: [{ type: "bool" }],
	},
	{
		name: "renew",
		type: "function",
		stateMutability: "payable",
		inputs: [
			{ name: "name", type: "string" },
			{ name: "duration", type: "uint256" },
		],
		outputs: [],
	},
	{
		name: "rentPrice",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "name", type: "string" },
			{ name: "duration", type: "uint256" },
		],
		outputs: [
			{
				name: "price",
				type: "tuple",
				components: [
					{ name: "base", type: "uint256" },
					{ name: "premium", type: "uint256" },
				],
			},
		],
	},
	{
		name: "makeCommitment",
		type: "function",
		stateMutability: "pure",
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
		outputs: [{ type: "bytes32" }],
	},
	{
		name: "commit",
		type: "function",
		stateMutability: "nonpayable",
		inputs: [{ name: "commitment", type: "bytes32" }],
		outputs: [],
	},
	{
		name: "register",
		type: "function",
		stateMutability: "payable",
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
] as const;

export const BASE_REGISTRAR_ABI = [
	{
		name: "nameExpires",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "id", type: "uint256" }],
		outputs: [{ type: "uint256" }],
	},
	{
		name: "ownerOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ type: "address" }],
	},
] as const;

export const ENS_REGISTRY_ABI = [
	{
		name: "owner",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "node", type: "bytes32" }],
		outputs: [{ type: "address" }],
	},
	{
		name: "setSubnodeRecord",
		type: "function",
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "label", type: "bytes32" },
			{ name: "owner", type: "address" },
			{ name: "resolver", type: "address" },
			{ name: "ttl", type: "uint64" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		name: "setSubnodeOwner",
		type: "function",
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "label", type: "bytes32" },
			{ name: "owner", type: "address" },
		],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "nonpayable",
	},
] as const;

export const NAME_WRAPPER_ABI = [
	{
		name: "setSubnodeRecord",
		type: "function",
		inputs: [
			{ name: "parentNode", type: "bytes32" },
			{ name: "label", type: "string" },
			{ name: "owner", type: "address" },
			{ name: "resolver", type: "address" },
			{ name: "ttl", type: "uint64" },
			{ name: "fuses", type: "uint32" },
			{ name: "expiry", type: "uint64" },
		],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "nonpayable",
	},
	{
		name: "ownerOf",
		type: "function",
		inputs: [{ name: "id", type: "uint256" }],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
	{
		name: "getData",
		type: "function",
		inputs: [{ name: "id", type: "uint256" }],
		outputs: [
			{ name: "owner", type: "address" },
			{ name: "fuses", type: "uint32" },
			{ name: "expiry", type: "uint64" },
		],
		stateMutability: "view",
	},
	{
		name: "isWrapped",
		type: "function",
		inputs: [{ name: "node", type: "bytes32" }],
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "view",
	},
] as const;

// Public Resolver - for setting address records after subname creation
export const PUBLIC_RESOLVER_ABI = [
	{
		name: "setAddr",
		type: "function",
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "a", type: "address" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		name: "setAddr",
		type: "function",
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "coinType", type: "uint256" },
			{ name: "a", type: "bytes" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
	{
		name: "addr",
		type: "function",
		inputs: [{ name: "node", type: "bytes32" }],
		outputs: [{ name: "", type: "address" }],
		stateMutability: "view",
	},
] as const;

// Multicall for batching setSubnodeRecord + setAddr in one transaction
const MULTICALL_ABI = [
	{
		name: "multicall",
		type: "function",
		inputs: [{ name: "data", type: "bytes[]" }],
		outputs: [{ name: "results", type: "bytes[]" }],
		stateMutability: "nonpayable",
	},
] as const;

export const ENS_REGISTRY_SET_OWNER_ABI = [
	{
		name: "setOwner",
		type: "function",
		inputs: [
			{ name: "node", type: "bytes32" },
			{ name: "owner", type: "address" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;

export const NAME_WRAPPER_TRANSFER_ABI = [
	{
		name: "safeTransferFrom",
		type: "function",
		inputs: [
			{ name: "from", type: "address" },
			{ name: "to", type: "address" },
			{ name: "id", type: "uint256" },
			{ name: "amount", type: "uint256" },
			{ name: "data", type: "bytes" },
		],
		outputs: [],
		stateMutability: "nonpayable",
	},
] as const;

// Reverse Registrar - for setting primary ENS name
export const REVERSE_REGISTRAR_ABI = [
	{
		name: "setName",
		type: "function",
		inputs: [{ name: "name", type: "string" }],
		outputs: [{ name: "", type: "bytes32" }],
		stateMutability: "nonpayable",
	},
] as const;
