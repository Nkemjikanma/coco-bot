import { NameCheckData, ExpiryData, HistoryData, PortfolioData } from "./types";
import { truncateAddress, formatDate, daysFromNow } from "./utils";

export function formatCheckResponse(data: NameCheckData): string {
  const { values } = data;

  if (values.length === 1) {
    const v = values[0];

    if (!v.isAvailable) {
      return `❌ **${v.name}** is taken

👤 Owner: ${v.owner ? truncateAddress(v.owner) : "Unknown"}
📅 Expires: ${v.expiration ? formatDate(v.expiration) : "Unknown"}

Want to watch for availability? Use \`/watch ${v.name}\``;
    }

    return `✅ **${v.name}** is available!

💰 Registration price: ${v.registerationPrice ?? "Unknown"} ETH/year

Ready to register? Use \`/register ${v.name} <years>\``;
  }

  const availableCount = values.filter((v) => v.isAvailable).length;
  const takenCount = values.length - availableCount;

  const nameResults = values
    .map((v) => {
      if (v.isAvailable) {
        return `✅ ${v.name} — Available (${v.registerationPrice ?? "?"} ETH/year)`;
      }
      return `❌ ${v.name} — Taken (expires ${v.expiration ? formatDate(v.expiration) : "Unknown"})`;
    })
    .join("\n");

  return `🔍 **Name Check Results**

${nameResults}

Available: ${availableCount} | Taken: ${takenCount}`;
}

export function formatExpiryResponse(data: ExpiryData): string {
  const { values } = data;

  if (values.length === 1) {
    let v = values[0];

    if (v.isExpired) {
      if (!v.isInGracePeriod) {
        return `
💀 **${v.name}** Expiry Info

📅 Expired: ${formatDate(v.expiryDate)} 
🛡️ Grace period ended: ${formatDate(v.gracePeriodEnd)}

Status: ❌ Expired — Available for registration

Register it with \`/register ${v.name} <years>\`
`;
      }

      return `
⚠️ **${v.name}** Expiry Info

📅 Expired: ${formatDate(v.expiryDate)} 
🛡️ Grace period ends: ${formatDate(v.gracePeriodEnd)} 
⏳ Grace period days left: ${daysFromNow(v.gracePeriodEnd)} 

Status: ⚠️ In Grace Period — Only you can renew!

Renew now with \`/renew ${v.name} <years>\`
`;
    }

    return `
⏰ **${v.name}** Expiry Info

📅 Expires: ${formatDate(v.expiryDate)} 
⏳ Days remaining: ${daysFromNow(v.expiryDate)}
🛡️ Grace period ends: ${formatDate(v.gracePeriodEnd)}

Status: ✅ Active

`;
  }

  const needsAttention = values.filter((v) => v.isInGracePeriod).length;
  const expiry = values
    .map((v) => {
      if (v.isExpired) {
        if (v.isInGracePeriod) {
          return `⚠️ ${v.name} - IN GRACE PERIOD (${daysFromNow(v.gracePeriodEnd)} days to renew!)`;
        }

        return `❌ ${v.name} - IS EXPIRED`;
      }

      return `✅ ${v.name} — ${daysFromNow(v.expiryDate)} days left (${formatDate(v.expiryDate)})`;
    })
    .join("\n");

  return `⏰ **Expiry Check Results** \n

${expiry}

 ${needsAttention < 1 ? "" : `⚠️ ${needsAttention} needs Attention!`}
`;
}

export function formatHistoryResponse(name: string, data: HistoryData): string {
  const { events } = data;

  if (events.length === 0) {
    return `
📜 **${name}** History

No history found. This name may not be registered yet.
`;
  }

  const history = events
    .map((event) => {
      if (event.type === "registration") {
        return `
🎂 **Registered** — ${formatDate(event.timestamp)} 
   To: ${truncateAddress(event.to)}
   Duration: ${event.duration}
   Tx: ${truncateAddress(event.transactionHash)}
`;
      }

      if (event.type === "renewal") {
        return `
🔄 **Renewed** — ${formatDate(event.timestamp)} 
   Duration: ${event.duration} 
   Tx: ${event.transactionHash}
`;
      }

      if (event.type === "transfer") {
        return `
📤 **Transferred** — ${formatDate(event.timestamp)}
   From: ${truncateAddress(event.from)}
   To: ${truncateAddress(event.to)}
   Tx: ${truncateAddress(event.transactionHash)}
`;
      }

      return `
📝 **Records Updated** — ${formatDate(event.timestamp)}
   Tx: ${truncateAddress(event.transactionHash)}
`;
    })
    .join("\n");
  return `
📜 **${name}** History

${history}

Total events: ${events.length}
`;
}

export function formatPortfolioResponse(
  address: string,
  data: PortfolioData,
): string {
  const { names, totalCount, primaryName } = data;

  if (names.length === 0) {
    return `
📂 **Portfolio for ${truncateAddress(address)}**

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
        return `❌ ${name.name} - IS EXPIRED`;
      }

      if (daysFromNow(name.expiryDate) < 60) {
        return `⚠️ ${name.name} — expires ${formatDate(name.expiryDate)} (${daysFromNow(name.expiryDate)} days!)`;
      }

      if (name.isPrimary) {
        return ` ✅ ${name.name} — expires ${formatDate(name.expiryDate)} ⭐ Primary`;
      }

      return ` ✅ ${name.name} — expires ${formatDate(name.expiryDate)}`;
    })
    .join("\n");
  return `
📂 **Portfolio for ${truncateAddress(address)}**

🏷️ Primary name: ${primaryName}

📋 **Owned Names ${names.length}**

${displayNames}

⚠️ ${expiringSoon < 1 ? "" : `${expiringSoon} name expiring soon!`} 

`;
}
