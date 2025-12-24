import { createClient } from "redis";

export const client = createClient({
  username: "default",
  password: process.env.REDIS!,
  socket: {
    host: "redis-19777.c10.us-east-1-2.ec2.cloud.redislabs.com",
    port: 19777,
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
