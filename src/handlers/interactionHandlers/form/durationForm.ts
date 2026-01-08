// import type { BotHandler } from "@towns-protocol/bot";
// import {
//   clearUserPendingCommand,
//   type UserState,
// } from "../../../db/userStateStore";
// import type { RegisterCommand } from "../../../types";
// import { executeValidCommand } from "../..";
// import type { FormCase, OnInteractionEventType } from "../types";

// export async function durationForm(
//   handler: BotHandler,
//   event: OnInteractionEventType,
//   confirmForm: FormCase,
//   userState: UserState,
// ) {
//   const { userId, channelId } = event;

//   const threadId = event.threadId || event.eventId;

//   if (!confirmForm) {
//     return;
//   }

//   for (const component of confirmForm.components) {
//     // Handle cancel
//     if (component.component.case === "button" && component.id === "cancel") {
//       await clearUserPendingCommand(userId);
//       await handler.sendMessage(channelId, "Registration cancelled. 👋", {
//         threadId,
//       });
//       return;
//     }

//     // handle duration input
//     if (
//       component.component.case === "textInput" &&
//       component.id === "duration_text_field"
//     ) {
//       const durationStr = component.component.value.value;
//       const duration = parseInt(durationStr, 10);

//       // Validate duration
//       if (Number.isNaN(duration) || duration < 1 || duration > 10) {
//         await handler.sendMessage(
//           channelId,
//           "Please enter a valid duration between 1 and 10 years.",
//           { threadId },
//         );
//         return;
//       }

//       // Type guarding to get the RegisterCommand
//       const partialCommand =
//         userState.pendingCommand && userState.pendingCommand.partialCommand;

//       if (!partialCommand?.action) {
//         return;
//       }

//       // Ensure it's a register command
//       if (partialCommand.action !== "register") {
//         await handler.sendMessage(
//           channelId,
//           "Something went wrong. Please start again.",
//           { threadId },
//         );
//         await clearUserPendingCommand(userId);
//         return;
//       }

//       const updatedCommand: RegisterCommand = {
//         action: "register",
//         name: partialCommand.name ?? "",
//         duration,
//       };

//       if (!updatedCommand.name) {
//         await handler.sendMessage(
//           channelId,
//           "Something went wrong. Please start again.",
//           { threadId },
//         );
//         await clearUserPendingCommand(userId);
//         return;
//       }

//       // Clear pending state
//       await clearUserPendingCommand(userId);
//       await executeValidCommand(
//         handler,
//         channelId,
//         threadId,
//         userId,
//         updatedCommand,
//       );
//       return;
//     }
//   }
// }
