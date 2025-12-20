import { DateLike } from "./types";
export function truncateAddress(address: string): string {
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

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

export function daysFromNow(date: Date): number {
  const now = new Date();
  const givenDate = new Date(date);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  return Math.floor((givenDate.getTime() - now.getTime()) / MS_PER_DAY);
}
