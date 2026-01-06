import { client } from "../../db/redisClient";
import type { MetricEvent, TransactionMetric } from "./metrics.types";

const KEYS = {
  commandCount: (command: string) => `metrics:commands:${command}`,
  dailyActiveUsers: (date: string) => `metrics:dau:${date}`,
  eventCount: (event: MetricEvent) => `metrics:events:${event}`,

  // Transactions
  transactions: "metrics:transactions",
  totalGasSpent: "metrics:total_gas",
  totalCostWei: "metrics:total_cost",

  // User-specific
  userCommands: (userId: string) => `metrics:user:${userId}:commands`,
  userTransactions: (userId: string) => `metrics:user:${userId}:transactions`,

  // Time-series (for charts)
  hourlyCommands: (hour: string) => `metrics:hourly:${hour}:commands`,
  dailyRegistrations: (date: string) => `metrics:daily:${date}:registrations`,
};

function getToday(): string {
  return new Date().toISOString().split("T")[0]; // "2025-01-06"
}

function getCurrentHour(): string {
  const now = new Date();
  return `${now.toISOString().split("T")[0]}:${now.getHours().toString().padStart(2, "0")}`;
}

class Metrics {
  /**
   * Track a generic event
   */
  async trackEvent(
    event: MetricEvent,
    metadata?: Record<string, string>,
  ): Promise<void> {
    try {
      const multi = client.multi();

      // increment event counter
      multi.INCR(KEYS.eventCount(event));

      // store with timestamp
      const eventData = JSON.stringify({
        event,
        timeStamp: Date.now(),
        ...metadata,
      });

      multi.lPush("metrics:event_log", eventData);
      multi.lTrim("metrics:event_log", 0, 9999); // Keep last 10k events

      await multi.exec();
    } catch (error) {
      console.error("Failed to track event:", error);
    }
  }

  /**
   * Track a command usage
   */
  async trackCommand(
    command: string,
    userId: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    try {
      const today = getToday();
      const hour = getCurrentHour();

      const multi = client.multi();

      // increment command counter
      multi.INCR(KEYS.commandCount(command));

      // Track daily active users (use Set for uniqueness)
      multi.sAdd(KEYS.dailyActiveUsers(today), userId);

      // Track user's command count
      multi.incr(KEYS.userCommands(userId));

      // Hourly tracking for charts
      multi.incr(KEYS.hourlyCommands(hour));

      // Set TTL on daily/hourly keys (30 days retention)
      multi.expire(KEYS.dailyActiveUsers(today), 60 * 60 * 24 * 30);
      multi.expire(KEYS.hourlyCommands(hour), 60 * 60 * 24 * 30);

      await multi.exec();

      await this.trackEvent("command_received", {
        command,
        userId,
        ...metadata,
      });
    } catch (error) {
      console.error("Failed to track command:", error);
    }
  }

  /**
   * Track a completed transaction
   */
  async trackTransaction(tx: TransactionMetric): Promise<void> {
    try {
      const today = getToday();
      const multi = client.multi();

      // Store transaction details
      multi.lPush(KEYS.transactions, JSON.stringify(tx));
      multi.lTrim(KEYS.transactions, 0, 9999);

      // Increment type counter
      multi.incr(`metrics:tx_count:${tx.type}`);

      // Track daily transactions by type
      multi.incr(`metrics:daily:${today}:${tx.type}`);

      // Track costs (only if provided)
      if (tx.costWei) {
        multi.incrBy(KEYS.totalCostWei, Number(tx.costWei));
      }

      // Track user's transactions
      multi.incr(KEYS.userTransactions(tx.userId));

      await multi.exec();
    } catch (error) {
      console.error("Failed to track transaction:", error);
    }
  }

  // ============ Retrieval Methods ============

  /**
   * Get overview stats
   */
  async getOverview(): Promise<{
    totalCommands: number;
    totalRegistrations: number;
    totalTransfers: number;
    totalSubdomains: number;
    totalBridges: number;
    totalCostEth: string;
    dailyActiveUsers: number;
    uniqueUsers: number;
  }> {
    const today = getToday();

    const [
      checkCount,
      registerCount,
      transferCount,
      subdomainCount,
      portfolioCount,
      registrationTx,
      transferTx,
      subdomainTx,
      bridgeTx,
      totalCostWei,
      dauCount,
    ] = await Promise.all([
      client.get(KEYS.commandCount("check")),
      client.get(KEYS.commandCount("register")),
      client.get(KEYS.commandCount("transfer")),
      client.get(KEYS.commandCount("subdomain")),
      client.get(KEYS.commandCount("portfolio")),
      client.get("metrics:tx_count:registration"),
      client.get("metrics:tx_count:transfer"),
      client.get("metrics:tx_count:subdomain"),
      client.get("metrics:tx_count:bridge"),
      client.get(KEYS.totalCostWei),
      client.sCard(KEYS.dailyActiveUsers(today)),
    ]);

    const totalCommands =
      parseInt(checkCount || "0") +
      parseInt(registerCount || "0") +
      parseInt(transferCount || "0") +
      parseInt(subdomainCount || "0") +
      parseInt(portfolioCount || "0");

    // Convert wei to ETH
    const costWei = BigInt(totalCostWei || "0");
    const costEth = (Number(costWei) / 1e18).toFixed(4);

    return {
      totalCommands,
      totalRegistrations: parseInt(registrationTx || "0"),
      totalTransfers: parseInt(transferTx || "0"),
      totalSubdomains: parseInt(subdomainTx || "0"),
      totalBridges: parseInt(bridgeTx || "0"),
      totalCostEth: costEth,
      dailyActiveUsers: dauCount,
      uniqueUsers: 0, // Would need separate tracking
    };
  }

  /**
   * Get command breakdown
   */
  async getCommandStats(): Promise<Record<string, number>> {
    const commands = [
      "check",
      "register",
      "transfer",
      "subdomain",
      "portfolio",
      "expiry",
      "history",
      "help",
    ];

    const results = await Promise.all(
      commands.map(async (cmd) => {
        const count = await client.get(KEYS.commandCount(cmd));
        return [cmd, parseInt(count || "0")] as [string, number];
      }),
    );

    return Object.fromEntries(results);
  }

  /**
   * Get recent transactions
   */
  async getRecentTransactions(
    limit: number = 50,
  ): Promise<TransactionMetric[]> {
    const txList = await client.lRange(KEYS.transactions, 0, limit - 1);
    return txList.map((tx) => JSON.parse(tx));
  }

  /**
   * Get daily stats for a date range
   */
  async getDailyStats(days: number = 7): Promise<
    Array<{
      date: string;
      registrations: number;
      transfers: number;
      subdomains: number;
      dau: number;
    }>
  > {
    const stats = [];

    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];

      const [registrations, transfers, subdomains, dau] = await Promise.all([
        client.get(`metrics:daily:${dateStr}:registration`),
        client.get(`metrics:daily:${dateStr}:transfer`),
        client.get(`metrics:daily:${dateStr}:subdomain`),
        client.sCard(KEYS.dailyActiveUsers(dateStr)),
      ]);

      stats.push({
        date: dateStr,
        registrations: parseInt(registrations || "0"),
        transfers: parseInt(transfers || "0"),
        subdomains: parseInt(subdomains || "0"),
        dau,
      });
    }

    return stats.reverse();
  }
}

export const metrics = new Metrics();
