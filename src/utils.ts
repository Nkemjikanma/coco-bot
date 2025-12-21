/**
 * Shortens an Ethereum address for display
 * Example: 0x1234567890abcdef... -> 0x1234...cdef
 */
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Calculates days until a future date
 */
export function daysFromNow(date: Date): number {
  const now = new Date();
  const givenDate = new Date(date);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  return Math.floor((givenDate.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Formats ETH price to 4 decimal places
 */
export function formatPrice(priceEth: string): string {
  return Number(priceEth).toFixed(4);
}

/**
 * Formats a given date
 * @param date
 * @returns
 */
export function formatDate(date: Date | string | number | bigint): string {
  // Handle BigInt strings (Unix timestamp in seconds)
  if (typeof date === "string") {
    try {
      const timestamp = BigInt(date);
      const milliseconds = Number(timestamp) * 1000;
      return new Date(milliseconds).toDateString();
    } catch {
      return "Unknown date";
    }
  }

  // Handle BigInt directly
  if (typeof date === "bigint") {
    const milliseconds = Number(date) * 1000;
    return new Date(milliseconds).toDateString();
  }

  // Handle number (assume milliseconds if large, seconds if small)
  if (typeof date === "number") {
    const milliseconds = date > 1e12 ? date : date * 1000;
    return new Date(milliseconds).toDateString();
  }

  // Handle Date object
  return new Date(date).toDateString();
}

export function formatExpiryDate(expiryDate: string): string {
  try {
    const timestamp = BigInt(expiryDate);
    const date = new Date(Number(timestamp) * 1000);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "Unknown";
  }
}
