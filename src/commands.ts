import type { BotCommand } from "@towns-protocol/bot";

// Those commands will be registered to the bot as soon as the bot is initialized
// and will be available in the slash command autocomplete.
const commands = [
  {
    name: "help",
    description: "Get help with bot commands",
  },
  {
    name: "register",
    description: "Register new ENS name",
  },
  {
    name: "renew",
    description: "Renew ENS name",
  },
  { name: "migrate", description: "TODO: Migrate names to Namechain L2" },
] as const satisfies BotCommand[];

export default commands;
