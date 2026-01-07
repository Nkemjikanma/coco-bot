import {
  addEnsContracts,
  ensPublicActions,
  ensSubgraphActions,
} from "@ensdomains/ensjs";
import { getExpiry, getName, getOwner } from "@ensdomains/ensjs/public";
import { getNameHistory, getNamesForAddress } from "@ensdomains/ensjs/subgraph";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  formatEther,
  http,
  parseUnits,
  zeroAddress,
} from "viem";
import { readContract } from "viem/actions";
import { base, mainnet, sepolia } from "viem/chains";
import type {
  ApiResponse,
  ExpiryData,
  GetExpiryResponse,
  HistoryData,
  NameCheckData,
  NameCheckResponse,
  PortfolioData,
} from "../../api";
import type { PendingRegistration, RegistrationCommitment } from "../../types";
import {
  BASE_REGISTRAR_ABI,
  CONTROLLER_ABI,
  ENS_CONTRACTS,
  ENS_REGISTRY_ABI,
  MAINNET_RPC_URL,
  SUBGRAPH_API_KEY,
  TIME,
} from "./constants";
import { getSubdomainService } from "./subdomain/subdomain";
import {
  generateSecret,
  getActualOwnersBatch,
  getTokenId,
  mapEnsHistoryResponse,
  mapNamesForAddressToPortfolioData,
  namehash,
  normalizeENSName,
} from "./utils";

if (!MAINNET_RPC_URL || !SUBGRAPH_API_KEY) {
  throw new Error(
    "MAINNET_RPC_URL or SUBGRAPH environment variable is required",
  );
}

const mainnetWithEns = addEnsContracts(mainnet, {
  subgraphApiKey: SUBGRAPH_API_KEY,
});

const ethereumClient = createPublicClient({
  chain: mainnetWithEns,
  transport: http(MAINNET_RPC_URL),
})
  .extend(ensPublicActions)
  .extend(ensSubgraphActions);

/**
 * Checks if an ENS domain is available for registration
 */

export async function checkAvailability(
  domainNames: string,
): Promise<ApiResponse<NameCheckData>> {
  const normalisationList = [domainNames].map((name) => {
    const { normalized, valid, reason } = normalizeENSName(name);
    return { name, normalized, valid, reason };
  });

  // Pre-fill results for invalid names, keep indexes stable
  const results: NameCheckResponse[] = normalisationList.map((n) => {
    if (!n.valid) {
      return {
        name: n.name.endsWith(".eth") ? n.name : `${n.name}.eth`,
        isAvailable: false,
        error: n.reason,
      };
    }
    return {
      name: n.name.endsWith(".eth") ? n.name : `${n.name}.eth`,
      isAvailable: false, // will be overwritten
    };
  });

  const validIndexes = normalisationList
    .map((n, i) => (n.valid ? i : null))
    .filter((x): x is number => x !== null);

  try {
    // 1) Batch: available() for all valid names
    const availableCalls = validIndexes.map((i) => ({
      address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
      abi: CONTROLLER_ABI,
      functionName: "available" as const,
      args: [normalisationList[i].normalized] as const,
    }));

    const availableResp = await ethereumClient.multicall({
      contracts: availableCalls,
      allowFailure: true,
    });

    // Partition
    const unavailableIndexes: number[] = [];
    const availableIndexes: number[] = [];

    availableResp.forEach((r, j) => {
      const originalIdx = validIndexes[j];
      const ok = r.status === "success";
      if (!ok) {
        results[originalIdx] = {
          ...results[originalIdx],
          isAvailable: false,
          error: "Error checking availability. Let's try again later",
        };
        return;
      }

      const isAvailable = Boolean(r.result);
      results[originalIdx].isAvailable = isAvailable;

      if (isAvailable) availableIndexes.push(originalIdx);
      else unavailableIndexes.push(originalIdx);
    });

    // 2a) Batch: rentPrice() for available ones
    if (availableIndexes.length) {
      const rentCalls = availableIndexes.map((i) => ({
        address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
        abi: CONTROLLER_ABI,
        functionName: "rentPrice" as const,
        args: [normalisationList[i].normalized, TIME.SECONDS_PER_YEAR] as const,
      }));

      const rentResp = await ethereumClient.multicall({
        contracts: rentCalls,
        allowFailure: true,
      });

      rentResp.forEach((r, j) => {
        const originalIdx = availableIndexes[j];
        if (r.status !== "success") {
          results[originalIdx] = {
            ...results[originalIdx],
            isAvailable: false,
            error: "Error checking price. Let's try again later",
          };
          return;
        }
        const priceData = r.result as { base: bigint; premium: bigint };
        const totalPrice = priceData.base + priceData.premium;
        results[originalIdx].registrationPrice = Number(
          formatEther(totalPrice),
        ).toFixed(4);
      });
    }

    // 2b) Batch: ownerOf() + nameExpires() for unavailable ones
    if (unavailableIndexes.length) {
      const tokenIds = unavailableIndexes.map((i) =>
        getTokenId(normalisationList[i].normalized),
      );

      // Get expiry from BaseRegistrar (this is always correct regardless of wrapping)
      const expiryCalls = tokenIds.map((tokenId) => ({
        address: ENS_CONTRACTS.BASE_REGISTRAR,
        abi: BASE_REGISTRAR_ABI,
        functionName: "nameExpires" as const,
        args: [tokenId] as const,
      }));

      const expiriesResp = await ethereumClient.multicall({
        contracts: expiryCalls,
        allowFailure: true,
      });

      // Set expiry for all unavailable names
      unavailableIndexes.forEach((originalIdx, j) => {
        const expiryR = expiriesResp[j];
        if (expiryR.status === "success") {
          const expiryTimestamp = expiryR.result as bigint;
          results[originalIdx].expiration =
            expiryTimestamp === 0n ? undefined : (expiryTimestamp as any);
        }
      });

      // ✅ Get ACTUAL owners using the utility that handles wrapped names
      const unavailableNames = unavailableIndexes.map(
        (i) => `${normalisationList[i].normalized}.eth`,
      );

      const ownerInfoMap = await getActualOwnersBatch(unavailableNames);

      unavailableIndexes.forEach((originalIdx) => {
        const fullName = `${normalisationList[originalIdx].normalized}.eth`;
        const ownerInfo = ownerInfoMap.get(fullName);

        if (ownerInfo?.owner && ownerInfo.owner !== zeroAddress) {
          results[originalIdx].owner = ownerInfo.owner;
        }
      });
    }

    return { success: true, data: { values: results } };
  } catch (e) {
    return {
      success: false,
      error:
        (e as any)?.message ??
        "Error checking availability. Let's try again later",
    };
  }
}
/**
 * Checks ENS domain expiration information
 */
export async function checkExpiry(
  domainNames: string,
): Promise<ApiResponse<ExpiryData>> {
  try {
    const normalisationList = [domainNames].map((name) => {
      const { normalized, valid, reason } = normalizeENSName(name);
      return { name, normalized, valid, reason };
    });

    // Pre-fill invalid results and track valid indices
    const results: GetExpiryResponse[] = normalisationList.map((n) => {
      const fullName = `${n.normalized}.eth`;
      if (!n.valid) {
        return { name: fullName, error: n.reason ?? "Invalid name" };
      }
      return { name: fullName };
    });

    const validIndexes = normalisationList
      .map((n, i) => (n.valid ? i : null))
      .filter((x): x is number => x !== null);

    if (validIndexes.length === 0) {
      return { success: true, data: { values: results } };
    }

    const fullNames = validIndexes.map(
      (i) => `${normalisationList[i].normalized}.eth`,
    );

    // Batch 1: expiry for all valid names
    const expiryResponses = await ethereumClient.ensBatch(
      ...fullNames.map((name) => getExpiry.batch({ name })),
    );

    // Determine which names appear "unregistered" from expiry result
    // getExpiry may return null for non-.eth or if no expiry exists.
    const maybeUnregisteredIdx: number[] = [];

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);

    expiryResponses.forEach((res, j) => {
      const originalIdx = validIndexes[j];
      const name = fullNames[j];

      // If no expiry info, treat as unregistered / not applicable
      if (!res?.expiry?.date) {
        // We'll confirm with getOwner below to distinguish "unregistered" vs "no expiry data"
        maybeUnregisteredIdx.push(originalIdx);
        return;
      }

      const expiryDate = res.expiry.date; // Date
      const expirySec = Math.floor(expiryDate.getTime() / 1000);

      const daysUntilExpiry = Math.floor((expirySec - nowSec) / 86400);
      const isExpired = nowSec > expirySec;

      const gracePeriodEnd = new Date(
        (expirySec + TIME.GRACE_PERIOD_SECONDS) * 1000,
      );

      const isInGracePeriod =
        isExpired && nowSec < expirySec + TIME.GRACE_PERIOD_SECONDS;

      results[originalIdx] = {
        name,
        expiryDate,
        gracePeriodEnd,
        isExpired,
        isInGracePeriod,
        daysUntilExpiry,
      };
    });

    // Batch 2 (optional): for names with missing expiry, check owner to craft a nicer message
    // This also helps you detect "not registered" (owner=zero or no owner) scenarios.
    if (maybeUnregisteredIdx.length) {
      const ownerNames = maybeUnregisteredIdx.map((i) => results[i].name);

      // Note: ENSJS getOwner returns { owner: Address } (and sometimes other fields)
      // If a call fails or returns null-ish, we’ll show a generic message.
      const ownerResponses = await ethereumClient.ensBatch(
        ...ownerNames.map((name) => getOwner.batch({ name })),
      );

      ownerResponses.forEach((ownerRes, k) => {
        const originalIdx = maybeUnregisteredIdx[k];
        const fullName = ownerNames[k];

        const owner = ownerRes?.owner as Address | undefined;

        // If no owner data or zero address -> likely not registered
        if (!owner || owner === zeroAddress) {
          results[originalIdx] = {
            name: fullName,
            isExpired: false,
            error:
              `Name hasn't been registered, want to snag it? ` +
              `If yes, \`/register ${fullName}\` will do the job`,
          };
          return;
        }

        // If it has an owner but we couldn't compute expiry (e.g. non-.eth),
        // return a helpful error rather than making up expiry fields.
        results[originalIdx] = {
          name: fullName,
          error:
            "This name appears owned but expiry info isn't available via .eth expiry checks (it may not be a .eth 2LD).",
        };
      });
    }

    return { success: true, data: { values: results } };
  } catch (e: any) {
    return {
      success: false,
      error:
        e?.message ?? "Error getting expiry information. Let's try again later",
    };
  }
}
/**
 * Resolves an ENS domain name to its owner's Ethereum address
 * Supports both .eth domains and subdomains
 */
export async function resolveENSToAddress(
  domainName: string,
): Promise<
  | { success: true; address: string; fullName: string }
  | { success: false; reason: string }
> {
  try {
    // Normalize and validate the domain name
    const { normalized, valid, reason } = normalizeENSName(domainName);

    if (!valid) {
      return {
        success: false,
        reason: reason || "Invalid domain name",
      };
    }

    const fullName = normalized.endsWith(".eth")
      ? normalized
      : `${normalized}.eth`;

    // Check if it's a second-level .eth domain or a subdomain
    const isSecondLevel = !normalized.includes(".");
    const tokenId = getTokenId(normalized);

    if (isSecondLevel) {
      // For .eth domains, get the registrant (NFT owner) from BaseRegistrar
      try {
        const registrant = (await readContract(ethereumClient, {
          address: ENS_CONTRACTS.BASE_REGISTRAR,
          abi: BASE_REGISTRAR_ABI,
          functionName: "ownerOf",
          args: [tokenId],
        })) as string;

        return {
          success: true,
          address: registrant,
          fullName,
        };
      } catch (error) {
        // Domain not registered or expired beyond grace period
        return {
          success: false,
          reason: `${fullName} is not registered or has expired`,
        };
      }
    } else {
      // For subdomains, get the owner from ENS Registry
      try {
        const nodeHash = namehash(fullName);
        const owner = (await readContract(ethereumClient, {
          address: ENS_CONTRACTS.ENS_REGISTRY,
          abi: ENS_REGISTRY_ABI,
          functionName: "owner",
          args: [nodeHash],
        })) as string;

        // Check if owner is zero address (not set)
        if (owner === "0x0000000000000000000000000000000000000000" || !owner) {
          return {
            success: false,
            reason: `${fullName} does not have an owner set`,
          };
        }

        return {
          success: true,
          address: owner,
          fullName,
        };
      } catch (error) {
        return {
          success: false,
          reason: `Unable to resolve ${fullName}`,
        };
      }
    }
  } catch (error) {
    console.error("Error resolving ENS:", error);
    return {
      success: false,
      reason: "Error resolving ENS domain",
    };
  }
}

export async function getUserPorfolio(
  address: `0x${string}`,
): Promise<PortfolioData | null> {
  const result = await getNamesForAddress(ethereumClient, {
    address,
    orderBy: "expiryDate",
    orderDirection: "asc",
    pageSize: 6,
  });
  const primaryName = await getName(ethereumClient, {
    address,
  });

  console.log(primaryName);

  if (primaryName === null) {
    return null;
  }
  const data = mapNamesForAddressToPortfolioData(result, primaryName.name);
  return data;
}

export async function getHistory(name: string): Promise<HistoryData> {
  const result = await getNameHistory(ethereumClient, { name });
  const data = mapEnsHistoryResponse(result);
  return data;
}

// Estimate commit gas
export async function estimateCommitGas({
  account,
  commitment,
}: {
  account: `0x${string}`;
  commitment: `0x${string}`;
}): Promise<{ gasWei: bigint; gasEth: string }> {
  try {
    // Encode the commit function call
    const data = encodeFunctionData({
      abi: CONTROLLER_ABI,
      functionName: "commit",
      args: [commitment],
    });

    // Estimate gas with explicit parameters
    const gas = await ethereumClient.estimateGas({
      account,
      to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
      data,
    });

    const fees = await ethereumClient.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? 0n;
    const gasWei = gas * maxFeePerGas;

    return {
      gasWei,
      gasEth: formatEther(gasWei),
    };
  } catch (error) {
    console.error("Error estimating commit gas:", error);
    // Fallback to fixed estimate
    const fees = await ethereumClient.estimateFeesPerGas();
    const estimatedGas = 50000n;
    const gasWei = estimatedGas * (fees.maxFeePerGas ?? 0n);

    return {
      gasWei,
      gasEth: formatEther(gasWei),
    };
  }
}

// build the transaction data/hash
export async function makeCommitment({
  label,
  owner,
  durationSec,
  secret,
  resolver,
  data,
  reverseRecord,
  ownerControlledFuses,
}: {
  label: string;
  owner: `0x${string}`;
  durationSec: bigint;
  secret: `0x${string}`;
  resolver: `0x${string}`;
  data: `0x${string}`[];
  reverseRecord: boolean;
  ownerControlledFuses: number;
}): Promise<`0x${string}`> {
  // Use the controller's makeCommitment function
  const commitment = await ethereumClient.readContract({
    address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
    abi: CONTROLLER_ABI,
    functionName: "makeCommitment",
    args: [
      label,
      owner,
      durationSec,
      secret,
      resolver,
      data,
      reverseRecord,
      ownerControlledFuses,
    ],
  });

  return commitment as `0x${string}`;
}

export function encodeCommitData(commitment: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: CONTROLLER_ABI,
    functionName: "commit",
    args: [commitment],
  });
}

// Estimate registration
export async function estimateRegisterGas({
  account,
  label,
  owner,
  durationSec,
  secret,
  resolver,
  data,
  reverseRecord,
  ownerControlledFuses,
  value,
}: {
  account: `0x${string}`;
  label: string;
  owner: `0x${string}`;
  durationSec: bigint;
  secret: `0x${string}`;
  resolver: `0x${string}`;
  data: `0x${string}`[];
  reverseRecord: boolean;
  ownerControlledFuses: number;
  value: bigint;
}): Promise<{ gasWei: bigint; gasEth: string }> {
  try {
    // Encode the register function call
    const calldata = encodeFunctionData({
      abi: CONTROLLER_ABI,
      functionName: "register",
      args: [
        label,
        owner,
        durationSec,
        secret,
        resolver,
        data,
        reverseRecord,
        ownerControlledFuses,
      ],
    });

    // Estimate gas with explicit parameters
    const gas = await ethereumClient.estimateGas({
      account,
      to: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
      data: calldata,
      value,
    });

    const fees = await ethereumClient.estimateFeesPerGas();
    const maxFeePerGas = fees.maxFeePerGas ?? 0n;
    const gasWei = gas * maxFeePerGas;

    return {
      gasWei,
      gasEth: formatEther(gasWei),
    };
  } catch (error) {
    console.error("Error estimating register gas:", error);
    // Fallback to fixed estimate
    const fees = await ethereumClient.estimateFeesPerGas();
    const estimatedGas = 300000n;
    const gasWei = estimatedGas * (fees.maxFeePerGas ?? 0n);

    return {
      gasWei,
      gasEth: formatEther(gasWei),
    };
  }
}

export async function prepareRegistration({
  name,
  owner,
  durationYears,
}: {
  name: string;
  owner: `0x${string}`;
  durationYears: number;
}): Promise<PendingRegistration> {
  const durationSec = BigInt(durationYears * 365 * 24 * 60 * 60);
  const resolver = ENS_CONTRACTS.PUBLIC_RESOLVER;
  const data: `0x${string}`[] = [];
  const reverseRecord = false;
  const ownerControlledFuses = 0;

  const commitments: RegistrationCommitment[] = [];
  let totalDomainCostWei = 0n;
  let totalCommitGasWei = 0n;

  // Get label (remove .eth if present)
  const label = name.replace(/\.eth$/, "");

  // Get domain price
  const priceData = (await ethereumClient.readContract({
    address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
    abi: CONTROLLER_ABI,
    functionName: "rentPrice",
    args: [label, durationSec],
  })) as { base: bigint; premium: bigint };

  const domainPriceWei = priceData.base + priceData.premium;
  totalDomainCostWei += domainPriceWei;

  // Generate secret and commitment
  const secret = generateSecret();
  const commitment = await makeCommitment({
    label,
    owner,
    durationSec,
    secret,
    resolver,
    data,
    reverseRecord,
    ownerControlledFuses,
  });

  // Estimate commit gas for this commitment
  const commitGas = await estimateCommitGas({ account: owner, commitment });
  totalCommitGasWei += commitGas.gasWei;

  // Estimate register gas (rough estimate for phase 1)
  const fees = await ethereumClient.estimateFeesPerGas();
  const registerGasPerName = 280000n;
  const totalRegisterGasWei = registerGasPerName * (fees.maxFeePerGas ?? 0n);

  const grandTotalWei =
    totalDomainCostWei + totalCommitGasWei + totalRegisterGasWei;

  return {
    phase: "awaiting_commit_confirmation",
    name: `${label}.eth`,
    commitment: {
      name: `${label}.eth`,
      secret,
      commitment,
      owner,
      durationSec,
      domainPriceWei,
    },
    costs: {
      commitGasWei: totalCommitGasWei,
      commitGasEth: formatEther(totalCommitGasWei),
      registerGasWei: totalRegisterGasWei,
      registerGasEth: formatEther(totalRegisterGasWei),
      isRegisterEstimate: true,
    },
    totalDomainCostWei,
    totalDomainCostEth: formatEther(totalDomainCostWei),
    grandTotalWei,
    grandTotalEth: formatEther(grandTotalWei),
  };
}

export function encodeRegisterData({
  name,
  owner,
  duration,
  secret,
  resolver,
  data,
  reverseRecord,
  ownerControlledFuses,
}: {
  name: string;
  owner: `0x${string}`;
  duration: bigint;
  secret: `0x${string}`;
  resolver: `0x${string}`;
  data: `0x${string}`[];
  reverseRecord: boolean;
  ownerControlledFuses: number;
}): `0x${string}` {
  return encodeFunctionData({
    abi: CONTROLLER_ABI,
    functionName: "register",
    args: [
      name,
      owner,
      duration,
      secret,
      resolver,
      data,
      reverseRecord,
      ownerControlledFuses,
    ],
  });
}

// TODO: Consider for removal - Not used
/** * Estimate registration costs without creating commitments. * Use this for cost calculation before wallet selection. * Does not require an owner address since no commitments are generated. */
export async function estimateRegistrationCost({
  names,
  durationYears,
}: {
  names: string[];
  durationYears: number;
}): Promise<{
  costs: {
    commitGasWei: bigint;
    commitGasEth: string;
    registerGasWei: bigint;
    registerGasEth: string;
    isRegisterEstimate: boolean;
  };
  totalDomainCostWei: bigint;
  totalDomainCostEth: string;
  grandTotalWei: bigint;
  grandTotalEth: string;
}> {
  const durationSec = BigInt(durationYears * 365 * 24 * 60 * 60);

  let totalDomainCostWei = 0n;

  for (const name of names) {
    const label = name.replace(/\.eth$/, "");

    const priceData = (await ethereumClient.readContract({
      address: ENS_CONTRACTS.REGISTRAR_CONTROLLER,
      abi: CONTROLLER_ABI,
      functionName: "rentPrice",
      args: [label, durationSec],
    })) as { base: bigint; premium: bigint };

    const domainPriceWei = priceData.base + priceData.premium;
    totalDomainCostWei += domainPriceWei;
  }

  const fees = await ethereumClient.estimateFeesPerGas();
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;

  // Commit gas estimate: ~46,000 gas per commit
  const commitGasPerName = 46000n;
  const totalCommitGasWei =
    commitGasPerName * BigInt(names.length) * maxFeePerGas;

  // Register gas estimate: ~280,000 gas per registration
  const registerGasPerName = 280000n;
  const totalRegisterGasWei =
    registerGasPerName * BigInt(names.length) * maxFeePerGas;

  const grandTotalWei =
    totalDomainCostWei + totalCommitGasWei + totalRegisterGasWei;

  return {
    costs: {
      commitGasWei: totalCommitGasWei,
      commitGasEth: formatEther(totalCommitGasWei),
      registerGasWei: totalRegisterGasWei,
      registerGasEth: formatEther(totalRegisterGasWei),
      isRegisterEstimate: true,
    },
    totalDomainCostWei,
    totalDomainCostEth: formatEther(totalDomainCostWei),
    grandTotalWei,
    grandTotalEth: formatEther(grandTotalWei),
  };
}
