import { bot } from "./bot";
import { initRedis } from "./db";

// await initRedis();
// console.log("✅ Redis connected");
//
// const app = bot.start();
//
// app.get("/", (c) => c.text("Coco is up and running"));
// export default app;
async function startBot() {
  try {
    await initRedis();
    console.log("✅ Redis connected");

    const app = bot.start();
    app.get("/", (c) => c.text("Coco is up and running"));

    return app;
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

export default await startBot();
