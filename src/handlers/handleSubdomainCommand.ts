import { BotHandler } from "@towns-protocol/bot";
import { EventType } from "../types";
import { SubdomainService } from "../services/ens/subdomain/subdomain";

export async function handleSubdomainCommand(
  handler: BotHandler,
  event: EventType,
  channelId: string,
  threadId: string | undefined,
  userId: string,
  parsed: {
    label: string;
    parentName: string;
  },
  userAddress: `0x${string}`,
): Promise<void> {
  const service = new SubdomainService(
    process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
  );

  const messageOptions = threadId ? { threadId } : undefined;
  const fullSubname = `${parsed.label}.${parsed.parentName}`;
}
