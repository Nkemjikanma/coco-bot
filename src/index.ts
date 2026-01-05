import { bot } from "./bot";
import { initRedis } from "./db";

async function startBot() {
  console.log("We are here");
  try {
    await initRedis();
    console.log("✅ Redis connected");

    const app = bot.start();
    app.get("/", (c) => c.text("Coco is up and running"));
    app.get("/.well-known/agent-metadata.json", async (c) => {
      return c.json(await bot.getIdentityMetadata());
    });
    return app;
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

export default await startBot();
