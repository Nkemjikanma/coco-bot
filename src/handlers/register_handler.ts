import { BotHandler, BasePayload } from "@towns-protocol/bot";

export async function register_handler(
  handler: BotHandler,
  payload: BasePayload,
) {
  const currentTime = new Date().toLocaleString();

  await handler.sendMessage(
    payload.channelId,
    `Current time: ${currentTime} ⏰`,
  );
}
