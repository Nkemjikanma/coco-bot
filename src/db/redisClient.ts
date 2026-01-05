import { createClient } from "redis";

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

if (!REDIS_HOST || !REDIS_PASSWORD) {
  throw new Error("REDIS_HOST and REDIS_PASSWORD must be set");
}

export const client = createClient({
  username: "default",
  password: REDIS_PASSWORD,
  socket: {
    host: REDIS_HOST,
    port: parseInt(REDIS_PORT!) || 19777,
    // tls: true,
    // rejectUnauthorized: true,
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("Redis: Max reconnection attempts reached");
        return new Error("Max reconnection attempts reached");
      }
      // Exponential backoff: 100ms, 200ms, 400ms, etc.
      const delay = Math.min(retries * 100, 3000);
      console.log(`Redis: Reconnecting in ${delay}ms... (attempt ${retries})`);
      return delay;
    },
  },
});

client.on("error", (err) => console.log("Redis Client Error", err));
client.on("connect", () => {
  console.log("Redis: Connected");
});

client.on("reconnecting", () => {
  console.log("Redis: Reconnecting...");
});

client.on("ready", () => {
  console.log("Redis: Ready");
});

export async function initRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
}
