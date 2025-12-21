import type { BotCommand } from "@towns-protocol/bot";

const commands = [
  {
    name: "help",
    description: "Get help with bot commands",
  },
  { name: "check", description: "Check availability of name" },
  {
    name: "register",
    description: "Register new ENS name",
  },
  {
    name: "renew",
    description: "Renew ENS name",
  },
  { name: "transfer", description: "Transfer name to another wallet" },
  { name: "set", description: "Set records" },
  {
    name: "subdomain",
    description: "Handle creation and listing of subdomains",
  },
  { name: "portfolio", description: "Check wallet ens portfolio" },
  { name: "expiry", description: "Check ENS expiry" },
  { name: "history", description: "Check ENS address history" },
  { name: "remind", description: "Set ENS renewal reminder" },
  { name: "watch", description: "Watch for when name becomes available" },
  // { name: "migrate", description: "TODO: Migrate names to Namechain L2" },
] as const satisfies BotCommand[];

export default commands;
