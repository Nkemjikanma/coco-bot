import { BotHandler, DecryptedInteractionResponse } from "@towns-protocol/bot";
import { FormCase, OnInteractionEventType } from "../types";
import {
  clearUserPendingCommand,
  getPendingRegistration,
  UserState,
} from "../../../db/userStateStore";
import { RegisterCommand } from "../../../types";
import { executeValidCommand } from "../..";

export async function durationForm(
  handler: BotHandler,
  event: OnInteractionEventType,
  confirmForm: FormCase,
  userState: UserState,
) {
  const { userId, channelId, threadId } = event;

  const validThreadId = event.threadId ?? userState.activeThreadId ?? channelId;

  if (!confirmForm) {
    return;
  }

  for (const component of confirmForm.components) {
    // Handle cancel
    if (component.component.case === "button" && component.id === "cancel") {
      await clearUserPendingCommand(userId);
      await handler.sendMessage(channelId, "Registration cancelled. 👋", {
        threadId: validThreadId || undefined,
      });
      return;
    }

    // handle duration input
    if (
      component.component.case === "textInput" &&
      component.id === "duration_text_field"
    ) {
      const durationStr = component.component.value.value;
      const duration = parseInt(durationStr, 10);

      // Validate duration
      if (Number.isNaN(duration) || duration < 1 || duration > 10) {
        await handler.sendMessage(
          channelId,
          "Please enter a valid duration between 1 and 10 years.",
          { threadId: validThreadId || undefined },
        );
        return;
      }

      // Type guarding to get the RegisterCommand
      const partialCommand =
        userState.pendingCommand && userState.pendingCommand.partialCommand;

      if (!partialCommand?.action) {
        return;
      }

      // Ensure it's a register command
      if (partialCommand.action !== "register") {
        await handler.sendMessage(
          channelId,
          "Something went wrong. Please start again.",
          { threadId: validThreadId || undefined },
        );
        await clearUserPendingCommand(userId);
        return;
      }

      const updatedCommand: RegisterCommand = {
        action: "register",
        names: partialCommand.names ?? [],
        duration,
      };

      if (updatedCommand.names.length === 0) {
        await handler.sendMessage(
          channelId,
          "Something went wrong. Please start again.",
          { threadId: validThreadId || undefined },
        );
        await clearUserPendingCommand(userId);
        return;
      }

      // Clear pending state
      await clearUserPendingCommand(userId);
      await executeValidCommand(
        handler,
        channelId,
        validThreadId,
        userId,
        updatedCommand,
      );
      return;
    }
  }
}
