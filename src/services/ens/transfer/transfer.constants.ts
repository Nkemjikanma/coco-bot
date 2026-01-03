export const REGISTRY_SET_OWNER_ABI = [
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

export const REGISTRY_SET_SUBNODE_OWNER_ABI = [
  {
    name: "setSubnodeOwner",
    type: "function",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "label", type: "bytes32" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

export const BASE_REGISTRAR_SAFE_TRANSFER_ABI = [
  {
    name: "safeTransferFrom",
    type: "function",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const BASE_REGISTRAR_RECLAIM_ABI = [
  {
    name: "reclaim",
    type: "function",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export const NAME_WRAPPER_SAFE_TRANSFER_ABI = [
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

export const NAME_WRAPPER_SET_SUBNODE_OWNER_ABI = [
  {
    name: "setSubnodeOwner",
    type: "function",
    inputs: [
      { name: "parentNode", type: "bytes32" },
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "fuses", type: "uint32" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;
