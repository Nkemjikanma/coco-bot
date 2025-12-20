import { createPublicClient, http, formatEther } from "viem";
import { zeroAddress, type Address } from "viem";
import { mainnet } from "viem/chains";
import { readContract } from "viem/actions";
import { getName, getExpiry, getOwner } from "@ensdomains/ensjs/public";
import {
  addEnsContracts,
  ensPublicActions,
  ensSubgraphActions,
  ensWalletActions,
} from "@ensdomains/ensjs";
import {
  getNameHistory,
  GetNameHistoryReturnType,
  GetNamesForAddressReturnType,
  getNamesForAddress,
} from "@ensdomains/ensjs/subgraph";
import {
  ENS_CONTRACTS,
  TIME,
  CONTROLLER_ABI,
  BASE_REGISTRAR_ABI,
  ENS_REGISTRY_ABI,
  ENS_SUBGRAPH,
} from "./constants";
import {
  normalizeENSName,
  getTokenId,
  namehash,
  mapEnsHistoryResponse,
  mapNamesForAddressToPortfolioData,
} from "./utils";

import type {
  ENSAvailabilityResult,
  ENSExpiryResult,
  ENSUserPortfolio,
  ENSHistoryResult,
  ENSHistoryEvent,
} from "./types";

import type {
  ApiResponse,
  NameCheckData,
  NameCheckResponse,
  ExpiryData,
  GetExpiryResponse,
  HistoryData,
  PortfolioData,
} from "../../api";

const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL;
const SUBGRAPH = process.env.SUBGRAPH;

if (!MAINNET_RPC_URL || !SUBGRAPH) {
  throw new Error(
    "MAINNET_RPC_URL or SUBGRAPH environment variable is required",
  );
}

const mainnetWithEns = addEnsContracts(mainnet, {
  subgraphApiKey: SUBGRAPH,
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
  domainNames: string[],
): Promise<ApiResponse<NameCheckData>> {
  const normalisationList = domainNames.map((name) => {
    const { normalized, valid, reason } = normalizeENSName(name);
    return { name, normalized, valid, reason };
  });

  // Pre-fill results for invalid names, keep indexes stable
  const results: NameCheckResponse[] = normalisationList.map((n) => {
    if (!n.valid) {
      return {
        name: `${n.name}.eth`,
        isAvailable: false,
        error: n.reason,
      };
    }
    return {
      name: `${n.name}.eth`,
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

      const ownerCalls = tokenIds.map((tokenId) => ({
        address: ENS_CONTRACTS.BASE_REGISTRAR,
        abi: BASE_REGISTRAR_ABI,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      }));

      const expiryCalls = tokenIds.map((tokenId) => ({
        address: ENS_CONTRACTS.BASE_REGISTRAR,
        abi: BASE_REGISTRAR_ABI,
        functionName: "nameExpires" as const,
        args: [tokenId] as const,
      }));

      const [ownersResp, expiriesResp] = await Promise.all([
        ethereumClient.multicall({ contracts: ownerCalls, allowFailure: true }),
        ethereumClient.multicall({
          contracts: expiryCalls,
          allowFailure: true,
        }),
      ]);

      unavailableIndexes.forEach((originalIdx, j) => {
        const ownerR = ownersResp[j];
        const expiryR = expiriesResp[j];

        if (ownerR.status === "success") {
          const ownerAddress = ownerR.result as Address;
          results[originalIdx].owner =
            ownerAddress === zeroAddress ? undefined : ownerAddress;
        }

        if (expiryR.status === "success") {
          const expiryTimestamp = expiryR.result as bigint;
          results[originalIdx].expiration =
            expiryTimestamp === 0n ? undefined : (expiryTimestamp as any);
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
  domainNames: string[],
): Promise<ApiResponse<ExpiryData>> {
  try {
    const normalisationList = domainNames.map((name) => {
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

/**
 * Checks a user's ENS portfolio
 */
// export async function getUserPortfolio(
//   userAddress: string,
// ): Promise<ENSUserPortfolio> {
//   try {
//     // Query subgraph for all user's domains
//     const query = `
//     query GetUserDomains($owner: String!) {
//         account(id: $owner) {

//           registrations(first: 1000) {
//             domain {
//               name
//               labelName
//             }
//             expiryDate
//             registrationDate
//           }
//         }
//       }
//     `;

//     const response = await fetch(ENS_SUBGRAPH.LEGACY, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         query,
//         variables: {
//           owner: userAddress.toLowerCase(),
//         },
//       }),
//     });

//     const { data } = await response.json();
//     if (!data?.account) {
//       return {
//         address: userAddress,
//         totalDomains: 0,
//         activeDomains: 0,
//         expiredDomains: 0,
//         expiringSoon: 0,
//         inGracePeriod: 0,
//         domains: [],
//       };
//     }
//     const { registrations } = data.account;
//     const now = Math.floor(Date.now() / 1000);

//     // Process domain data from subgraph (no contract calls for speed)
//     const domains: ENSExpiryResult[] = registrations.map((reg: any) => {
//       const label = reg.domain.labelName;
//       const fullName = reg.domain.name;
//       const expiryTimestamp = Number(reg.expiryDate);
//       const expiryDate = new Date(expiryTimestamp * 1000);
//       const daysUntilExpiry = Math.floor((expiryTimestamp - now) / 86400);
//       const isExpired = now > expiryTimestamp;
//       const inGracePeriod =
//         isExpired && now < expiryTimestamp + TIME.GRACE_PERIOD_SECONDS;
//       const gracePeriodEnds = new Date(
//         (expiryTimestamp + TIME.GRACE_PERIOD_SECONDS) * 1000,
//       );

//       return {
//         label,
//         fullName,
//         valid: true,
//         registered: true,
//         expirationDate: expiryDate,
//         daysUntilExpiry,
//         expired: isExpired,
//         inGracePeriod,
//         gracePeriodEnds,
//         registrant: userAddress,
//       };
//     });

//     // Calculate stats
//     const totalDomains = domains.length;
//     const activeDomains = domains.filter((d) => !d.expired).length;
//     const expiredDomains = domains.filter((d) => d.expired).length;
//     const inGracePeriodCount = domains.filter((d) => d.inGracePeriod).length;
//     const expiringSoon = domains.filter(
//       (d) =>
//         !d.expired &&
//         d.daysUntilExpiry !== undefined &&
//         d.daysUntilExpiry <= 30,
//     ).length;

//     // Sort by expiry date (soonest first for active, then expired domains)
//     domains.sort((a, b) => {
//       // Active domains before expired
//       if (a.expired && !b.expired) return 1;
//       if (!a.expired && b.expired) return -1;

//       // Within same status, sort by expiry date
//       return (
//         (a.expirationDate?.getTime() || 0) - (b.expirationDate?.getTime() || 0)
//       );
//     });

//     return {
//       address: userAddress,
//       totalDomains,
//       activeDomains,
//       expiredDomains,
//       expiringSoon,
//       inGracePeriod: inGracePeriodCount,
//       domains,
//     };
//   } catch (error) {
//     console.error("Error fetching user domains:", error);
//     throw error;
//   }
// }
export async function getUserPorfolio(
  address: `0x${string}`,
): Promise<PortfolioData> {
  const result = await getNamesForAddress(ethereumClient, {
    address,
    orderBy: "expiryDate",
    orderDirection: "asc",
    pageSize: 6,
  });
  const primaryName = await getName(ethereumClient, {
    address: "0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5",
  });
  const data = mapNamesForAddressToPortfolioData(result);
  return data;
}
/**
 * Gets the complete history of an ENS domain
 */
// export async function getDomainHistory(
//   domainName: string,
// ): Promise<ENSHistoryResult> {
//   try {
//     const { normalized, valid, reason } = normalizeENSName(domainName);
//     const fullName = `${normalized}.eth`;

//     if (!valid) {
//       return {
//         label: normalized,
//         fullName,
//         valid: false,
//         registered: false,
//         reason,
//         events: [],
//         totalTransfers: 0,
//         totalRenewals: 0,
//         totalResolverChanges: 0,
//       };
//     }

//     // GraphQL query to get domain history
//     const query = `
//       query GetDomainHistory($domainName: String!) {
//         domains(where: { name: $domainName }) {
//           id
//           name
//           labelName
//           createdAt
//           expiryDate
//           owner {
//             id
//           }
//           registrant {
//             id
//           }

//           registration {
//             registrationDate
//             expiryDate
//             cost
//             registrant {
//               id
//             }

//             events(orderBy: blockNumber, orderDirection: asc, first: 100) {
//               __typename
//               ... on NameRegistered {
//                 id
//                 blockNumber
//                 transactionID
//                 registrant {
//                   id
//                 }
//                 expiryDate
//               }
//               ... on NameRenewed {
//                 id
//                 blockNumber
//                 transactionID
//                 expiryDate
//               }
//               ... on NameTransferred {
//                 id
//                 blockNumber
//                 transactionID
//                 newOwner {
//                   id
//                 }
//               }
//             }
//           }

//           events(orderBy: blockNumber, orderDirection: asc, first: 100) {
//             __typename
//             ... on Transfer {
//               id
//               blockNumber
//               transactionID
//               owner {
//                 id
//               }
//             }
//             ... on NewResolver {
//               id
//               blockNumber
//               transactionID
//               resolver {
//                 address
//               }
//             }
//             ... on NameWrapped {
//               id
//               blockNumber
//               transactionID
//               owner {
//                 id
//               }
//               fuses
//               expiryDate
//             }
//             ... on NameUnwrapped {
//               id
//               blockNumber
//               transactionID
//               owner {
//                 id
//               }
//             }
//             ... on ExpiryExtended {
//               id
//               blockNumber
//               transactionID
//               expiryDate
//             }
//           }
//         }
//       }
//     `;

//     console.log("🔍 Querying subgraph:", ENS_SUBGRAPH.LEGACY);
//     console.log("🔍 Query variables:", { domainName: fullName });

//     const response = await fetch(ENS_SUBGRAPH.LEGACY, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//       },
//       body: JSON.stringify({
//         query,
//         variables: {
//           domainName: fullName,
//         },
//       }),
//     });

//     console.log("📡 Response status:", response.status, response.statusText);
//     console.log("📡 Response ok:", response.ok);

//     const responseText = await response.text();
//     console.log("📦 Raw response:", responseText.substring(0, 500));

//     let jsonResponse;
//     try {
//       jsonResponse = JSON.parse(responseText);
//     } catch (e) {
//       console.error("❌ Failed to parse JSON response:", e);
//       throw new Error("Invalid JSON response from subgraph");
//     }

//     console.log("📊 Parsed response:", JSON.stringify(jsonResponse, null, 2));

//     if (jsonResponse.errors) {
//       console.error("❌ GraphQL errors:", jsonResponse.errors);
//       throw new Error(
//         `GraphQL errors: ${jsonResponse.errors
//           .map((e: { message: string }) => e.message)
//           .join(", ")}`,
//       );
//     }

//     const { data } = jsonResponse;

//     if (!data?.domains || data.domains.length === 0) {
//       console.log("⚠️ No domains found in response");
//       return {
//         label: normalized,
//         fullName,
//         valid: true,
//         registered: false,
//         reason: "Domain not found in subgraph",
//         events: [],
//         totalTransfers: 0,
//         totalRenewals: 0,
//         totalResolverChanges: 0,
//       };
//     }

//     console.log("✅ Found domain data:", data.domains[0].name);

//     const domain = data.domains[0];
//     const events: ENSHistoryEvent[] = [];

//     // Process registration events
//     let totalRenewals = 0;
//     let totalTransfers = 0;
//     let initialRegistrant: string | undefined;
//     let registrationDate: Date | undefined;
//     let registrationCost: string | undefined;

//     if (domain.registration?.events) {
//       for (const event of domain.registration.events) {
//         if (event.__typename === "NameRegistered") {
//           initialRegistrant = event.registrant.id;
//           registrationDate = new Date(
//             parseInt(domain.registration.registrationDate) * 1000,
//           );
//           if (domain.registration.cost) {
//             registrationCost = formatEther(BigInt(domain.registration.cost));
//           }
//           events.push({
//             type: "registered",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Registered by ${event.registrant.id.slice(0, 8)}...`,
//           });
//         } else if (event.__typename === "NameRenewed") {
//           totalRenewals++;
//           const newExpiry = new Date(parseInt(event.expiryDate) * 1000);
//           events.push({
//             type: "renewed",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Renewed until ${newExpiry.toLocaleDateString()}`,
//           });
//         } else if (event.__typename === "NameTransferred") {
//           totalTransfers++;
//           events.push({
//             type: "transferred",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Transferred to ${event.newOwner.id.slice(0, 8)}...`,
//           });
//         }
//       }
//     }

//     // Process domain events
//     let totalResolverChanges = 0;
//     if (domain.events) {
//       for (const event of domain.events) {
//         if (event.__typename === "Transfer") {
//           // Skip if already counted in registration events
//           const alreadyCounted = events.some(
//             (e) =>
//               e.transactionHash === event.transactionID &&
//               e.type === "transferred",
//           );
//           if (!alreadyCounted) {
//             totalTransfers++;
//             events.push({
//               type: "transferred",
//               blockNumber: event.blockNumber,
//               transactionHash: event.transactionID,
//               details: `Controller transferred to ${event.owner.id.slice(
//                 0,
//                 8,
//               )}...`,
//             });
//           }
//         } else if (event.__typename === "NewResolver") {
//           totalResolverChanges++;
//           events.push({
//             type: "resolver_changed",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Resolver set to ${event.resolver.address.slice(0, 8)}...`,
//           });
//         } else if (event.__typename === "NameWrapped") {
//           events.push({
//             type: "wrapped",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Wrapped by ${event.owner.id.slice(0, 8)}...`,
//           });
//         } else if (event.__typename === "NameUnwrapped") {
//           events.push({
//             type: "unwrapped",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Unwrapped by ${event.owner.id.slice(0, 8)}...`,
//           });
//         } else if (event.__typename === "ExpiryExtended") {
//           const newExpiry = new Date(parseInt(event.expiryDate) * 1000);
//           events.push({
//             type: "expiry_extended",
//             blockNumber: event.blockNumber,
//             transactionHash: event.transactionID,
//             details: `Expiry extended to ${newExpiry.toLocaleDateString()}`,
//           });
//         }
//       }
//     }

//     // Sort events by block number
//     events.sort((a, b) => a.blockNumber - b.blockNumber);

//     return {
//       label: normalized,
//       fullName,
//       valid: true,
//       registered: true,
//       currentOwner: domain.owner?.id,
//       currentRegistrant: domain.registrant?.id,
//       expiryDate: domain.expiryDate
//         ? new Date(parseInt(domain.expiryDate) * 1000)
//         : undefined,
//       createdAt: domain.createdAt
//         ? new Date(parseInt(domain.createdAt) * 1000)
//         : undefined,
//       registrationDate,
//       registrationCost,
//       initialRegistrant,
//       events,
//       totalTransfers,
//       totalRenewals,
//       totalResolverChanges,
//     };
//   } catch (error) {
//     console.error("Error fetching domain history:", error);
//     throw error;
//   }
// }
export async function getHistory(name: string): Promise<HistoryData> {
  const result = await getNameHistory(ethereumClient, { name });
  const data = mapEnsHistoryResponse(result);
  return data;
}
