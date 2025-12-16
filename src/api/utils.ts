import { DateLike } from "./types";
export function truncateAddress(address: string): string {
  return `${address.slice(0, 5)}...${address.slice(-4)}`;
}

export function formatDate(date: DateLike): string {
  return new Date(date).toDateString().toString();
}

export function daysFromNow(date: DateLike): number {
  const now = new Date();
  const givenDate = new Date(date);

  const MS_PER_DAY = 1000 * 60 * 60 * 24;

  return Math.floor((givenDate.getTime() - now.getTime()) / MS_PER_DAY);
}
