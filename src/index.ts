import { bot } from "./bot";

const app = bot.start();

app.get("/", (c) => c.text("Coco is up and running"));
export default app;
