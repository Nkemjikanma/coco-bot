import { type Address, formatEther } from "viem";
import type { PendingRegistration } from "../types";
import {
	daysFromNow,
	formatAddress,
	formatDate,
	formatExpiryDate,
} from "../utils";
import type {
	ExpiryData,
	HistoryData,
	NameCheckData,
	PortfolioData,
} from "./types";
export function formatCheckResponse(data: NameCheckData): string {
	const { values } = data;

	const safeFormatDate = (d?: Date) => (d ? formatDate(d) : "Unknown");
	const safeOwner = (a?: Address) => (a ? formatAddress(a) : "Unknown");
	const safePrice = (p?: string) => (p ? `${p} ETH/year` : "Unknown");

	if (values.length === 0) {
		return `🔍 **Name Check Results**

No names provided.`;
	}

	if (values.length === 1) {
		const v = values[0];

		if (v.error) {
			return `🔍 **${v.name}** Name Check

❗ ${v.error}`;
		}

		if (!v.isAvailable) {
			return `❌ **${v.name}** is taken

👤 Owner: ${safeOwner(v.owner)}
📅 Expires: ${safeFormatDate(v.expiration)}

Want to watch for availability? Use \`/watch ${v.name}\``;
		}

		return `✅ **${v.name}** is available!

💰 Registration price: ${safePrice(v.registrationPrice)}

Ready to register? Use \`/register ${v.name} <years>\``;
	}

	const availableCount = values.filter((v) => v.isAvailable && !v.error).length;
	const errorCount = values.filter((v) => Boolean(v.error)).length;
	const takenCount = values.length - availableCount - errorCount;

	const nameResults = values
		.map((v) => {
			if (v.error) return `❗ ${v.name} — ${v.error}`;

			if (v.isAvailable) {
				return `✅ ${v.name} — Available (${safePrice(v.registrationPrice)})`;
			}

			const expiryText = v.expiration
				? safeFormatDate(v.expiration)
				: "Unknown";
			return `❌ ${v.name} — Taken${expiryText !== "Unknown" ? ` (expires ${expiryText})` : ""}`;
		})
		.join("\n");

	return `🔍 **Name Check Results**

${nameResults}

✅ Available: ${availableCount} | ❌ Taken: ${takenCount}${errorCount ? ` | ❗ Errors: ${errorCount}` : ""}`;
}

export function formatExpiryResponse(data: ExpiryData): string {
	const { values } = data;

	const safeFormatDate = (d?: Date) => (d ? formatDate(d) : "—");
	const safeDaysFromNow = (d?: Date) => (d ? daysFromNow(d) : undefined);

	if (values.length === 0) {
		return `
⏰ **Expiry Check Results**

No names provided.
`;
	}

	// Single-name response (more detailed)
	if (values.length === 1) {
		const v = values[0];

		// Errors first
		if (v.error) {
			return `
⏰ **${v.name}** Expiry Info

❗ ${v.error}
`;
		}

		// If we don't have expiry/grace info, avoid misleading output
		if (!v.expiryDate) {
			return `
⏰ **${v.name}** Expiry Info

No expiry information available for this name.
`;
		}

		// Expired paths
		if (v.isExpired) {
			// Expired + not in grace period => available to register
			if (v.isInGracePeriod === false) {
				return `
💀 **${v.name}** Expiry Info

📅 Expired: ${safeFormatDate(v.expiryDate)}
🛡️ Grace period ended: ${safeFormatDate(v.gracePeriodEnd)}

Status: ❌ Expired — Available for registration

Register it with \`/register ${v.name} <years>\`
`;
			}

			// Expired + in grace period
			if (v.isInGracePeriod) {
				const graceLeft = safeDaysFromNow(v.gracePeriodEnd);
				return `
⚠️ **${v.name}** Expiry Info

📅 Expired: ${safeFormatDate(v.expiryDate)}
🛡️ Grace period ends: ${safeFormatDate(v.gracePeriodEnd)}${
					typeof graceLeft === "number"
						? `\n⏳ Grace period days left: ${graceLeft}`
						: ""
				}

Status: ⚠️ In Grace Period — The current registrant can renew

Renew with \`/renew ${v.name} <years>\`
`;
			}

			// Expired but isInGracePeriod is missing
			return `
💀 **${v.name}** Expiry Info

📅 Expired: ${safeFormatDate(v.expiryDate)}
🛡️ Grace period end: ${safeFormatDate(v.gracePeriodEnd)}

Status: ❌ Expired

If it’s past the grace period, it may be available to register: \`/register ${v.name} <years>\`
`;
		}

		// Active path
		const daysLeft = safeDaysFromNow(v.expiryDate);
		return `
⏰ **${v.name}** Expiry Info

📅 Expires: ${safeFormatDate(v.expiryDate)}${
			typeof daysLeft === "number" ? `\n⏳ Days remaining: ${daysLeft}` : ""
		}
🛡️ Grace period ends: ${safeFormatDate(v.gracePeriodEnd)}

Status: ✅ Active
`;
	}

	// Multi-name response (list style)
	const lines = values.map((v) => {
		// Error rows
		if (v.error) return `❗ ${v.name} — ${v.error}`;

		// Missing expiry info
		if (!v.expiryDate) return `❓ ${v.name} — No expiry info`;

		if (v.isExpired) {
			if (v.isInGracePeriod) {
				const graceLeft = safeDaysFromNow(v.gracePeriodEnd);
				return `⚠️ ${v.name} — IN GRACE PERIOD${
					typeof graceLeft === "number"
						? ` (${graceLeft} days left to renew)`
						: ""
				}`;
			}
			return `❌ ${v.name} — EXPIRED`;
		}

		const daysLeft = safeDaysFromNow(v.expiryDate);
		return `✅ ${v.name} —${
			typeof daysLeft === "number" ? ` ${daysLeft} days left` : ""
		} (${safeFormatDate(v.expiryDate)})`;
	});

	const needsAttention = values.filter((v) => v.isInGracePeriod).length;
	const errorCount = values.filter((v) => Boolean(v.error)).length;

	return `⏰ **Expiry Check Results**

${lines.join("\n")}

${
	needsAttention > 0
		? `⚠️ ${needsAttention} name${needsAttention === 1 ? "" : "s"} in grace period.`
		: ""
}${needsAttention > 0 && errorCount > 0 ? "\n" : ""}${
	errorCount > 0
		? `❗ ${errorCount} name${errorCount === 1 ? "" : "s"} returned an error.`
		: ""
}
`;
}

export function formatHistoryResponse(name: string, data: HistoryData): string {
	const { events } = data;

	if (events.length === 0) {
		return `📜 **${name}** History

No history found. This name may not be registered yet.`;
	}

	const history = events
		.map((event) => {
			switch (event.type) {
				case "registered":
					return `🎂 **Registered** — Block ${event.blockNumber}
   To: ${formatAddress(event.to)}
   Expires: ${formatExpiryDate(event.expiryDate)}
   Tx: ${formatAddress(event.transactionHash)}`;

				case "renewed":
					return `🔄 **Renewed** — Block ${event.blockNumber}
   New Expiry: ${formatExpiryDate(event.expiryDate)}
   Tx: ${formatAddress(event.transactionHash)}`;

				case "transferred":
					return `📤 **Transferred** — Block ${event.blockNumber}
   To: ${formatAddress(event.to)}
   Tx: ${formatAddress(event.transactionHash)}`;

				case "wrapped":
					return `🎁 **Wrapped** — Block ${event.blockNumber}
   Owner: ${formatAddress(event.owner)}
   Tx: ${formatAddress(event.transactionHash)}`;

				case "unwrapped":
					return `📦 **Unwrapped** — Block ${event.blockNumber}
   Owner: ${formatAddress(event.owner)}
   Tx: ${formatAddress(event.transactionHash)}`;

				case "expiry_extended":
					return `⏰ **Expiry Extended** — Block ${event.blockNumber}
   New Expiry: ${formatExpiryDate(event.expiryDate)}
   Tx: ${formatAddress(event.transactionHash)}`;

				default:
					return null;
			}
		})
		.filter(Boolean)
		.join("\n\n");

	return `📜 **${name}** History

${history}

Total events: ${events.length}`;
}

export function formatPortfolioResponse(
	address: string,
	data: PortfolioData,
): string {
	const { names, totalCount, primaryName } = data;

	if (names.length === 0) {
		return `
📂 **Portfolio for ${formatAddress(address)}**

No ENS names found for this address.

Get started with \` /register <name> <years>\`
`;
	}

	const expiringSoon = names.filter(
		(n) => daysFromNow(n.expiryDate) < 60,
	).length;

	const displayNames = names
		.map((name) => {
			if (name.isExpired) {
				return `❌ ${name.name} - IS EXPIRED \n\n`;
			}

			if (daysFromNow(name.expiryDate) < 60) {
				return `⚠️ ${name.name} — expires ${formatDate(name.expiryDate)} (${daysFromNow(name.expiryDate)} days!) \n\n`;
			}

			if (name.isPrimary) {
				return ` ✅ ${name.name} — expires ${formatDate(name.expiryDate)} ⭐ Primary \n\n`;
			}

			return ` ✅ ${name.name} — expires ${formatDate(name.expiryDate)} \n\n`;
		})
		.join("\n\n");
	return `
📂 **Portfolio for ${formatAddress(address)}**

🏷️ Primary name: ${primaryName}

📋 **Owned Names ${names.length}**

${displayNames}

⚠️ ${expiringSoon < 1 ? "" : `${expiringSoon} name expiring soon! \n\n`}

`;
}

export function formatPhase1Summary(
	registration: PendingRegistration,
	durationYears: number,
): string {
	const n = registration.commitment;
	const label = n.name.replace(/\.eth$/, "");
	const priceEth = formatEther(n.domainPriceWei);
	const lengthNote = label.length <= 4 ? " (short name premium)" : "";

	const nameBreakdown =
		`**${n.name}** (${label.length} letters${lengthNote})\n\n` +
		`└─ Domain: ${priceEth} ETH`;

	return `
📋 **Registration Summary**

⏱️ Duration: ${durationYears} year${durationYears > 1 ? "s" : ""} \n\n

${nameBreakdown}

⛽ **Estimated Gas Costs** \n\n

├─ Commit tx: ~${registration.costs.commitGasEth} ETH \n\n
└─ Register tx: ~${registration.costs.registerGasEth} ETH _(estimate)_ \n\n

💰 **Estimated Total: ~${registration.grandTotalEth} ETH**

_This is a two-step process:_
1. _Commit (reserves the name)_
2. _Wait ~60 seconds_
3. _Register (completes registration)_

Ready to proceed?
  `.trim();
}

export function formatPhase2Summary(registration: PendingRegistration): string {
	const nameList = registration.name;

	return `
✅ **Commit Successful!**

Names reserved: ${nameList}

⏳ **Waiting Period**
You need to wait ~60 seconds before completing registration.

⛽ **Final Gas Cost**
└─ Register tx: ~${registration.costs.registerGasEth} ETH

💰 **Remaining Cost: ~${formatEther(registration.totalDomainCostWei + registration.costs.registerGasWei)} ETH**
_(Domain price + register gas)_

Ready to complete registration?
  `.trim();
}

export function formatMultiWalletPortfolio(
	addresses: `0x${string}`[],
	results: PortfolioData[],
): string {
	const totalDomains = results.reduce(
		(sum, r) => sum + (r.names?.length || 0),
		0,
	);

	let message = `📋 **Your ENS Portfolio**\n\n`;
	message += `Found **${totalDomains} ENS name(s)** across ${addresses.length} wallet(s):\n\n`;

	for (let i = 0; i < addresses.length; i++) {
		const addr = addresses[i];
		const result = results[i];

		if (result?.names && result.names.length > 0) {
			message += `**Wallet ${formatAddress(addr)}:**\n\n`;
			for (const domain of result.names) {
				const expiry = domain.expiryDate
					? ` (expires ${formatExpiryDate(domain.expiryDate)})`
					: "";
				message += `  • ${domain.name}${expiry}\n\n`;
			}
			message += `\n\n`;
		}
	}

	// Add wallets with no domains
	const emptyWallets = addresses.filter(
		(addr, i) => !results[i]?.names || results[i].names.length === 0,
	);

	if (emptyWallets.length > 0) {
		message += `*No ENS names found in: ${emptyWallets.map(formatAddress).join(", ")}*\n`;
	}

	return message;
}
