import { bot } from "./bot";
import { initRedis } from "./db";

async function startBot() {
	console.log("We are here");
	try {
		await initRedis();
		console.log("✅ Redis connected");

		const app = bot.start();

		// Add diagnostic logging middleware for all incoming requests
		app.use("*", async (c, next) => {
			const method = c.req.method;
			const path = c.req.path;
			const timestamp = new Date().toISOString();

			console.log(`\n📥 [${timestamp}] ${method} ${path}`);

			// Log webhook requests specifically
			if (path === "/webhook" || path.includes("webhook")) {
				console.log("🔔 WEBHOOK REQUEST RECEIVED");
				const authHeader = c.req.header("authorization");
				console.log("  Authorization header present:", !!authHeader);
				console.log("  Content-Type:", c.req.header("content-type"));
			}

			await next();

			console.log(`📤 [${timestamp}] ${method} ${path} -> ${c.res.status}`);
		});

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
