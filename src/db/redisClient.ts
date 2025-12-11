import { createClient } from "redis";

export const client = createClient({
  username: "default",
  password: process.env.REDIS!,
  socket: {
    host: "redis-19777.c10.us-east-1-2.ec2.cloud.redislabs.com",
    port: 19777,
  },
});

client.on("error", (err) => console.log("Redis Client Error", err));

export async function initRedis() {
  if (!client.isOpen) {
    await client.connect();
  }
}
