import Anthropic from "@anthropic-ai/sdk";
import {
  COMMAND_PARSER_PROMPT,
  CLARIFICATION_PROMPT,
  NAME_SUGGESTION_PROMPT,
  COST_EXPLANATION_PROMPT,
  ERROR_EXPLANATION_PROMPT,
  fill_prompt,
} from "./prompts";

import { validate_parse } from "./validators";
import { ParsedCommand } from "../types";

import { Message } from "../types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function coco_parser(
  user_message: string,
  recent_messages: Message[] = [],
): Promise<ParsedCommand> {
  const context = recent_messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  // command parser
  let command_parser = fill_prompt(COMMAND_PARSER_PROMPT, {
    message: user_message,
    context: context || "No recent context",
  });

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: command_parser }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    let json_response = JSON.parse(text);

    let validated_response: ParsedCommand = validate_parse(json_response);

    // Validate parsed command
    if (!validated_response.action) {
      throw new Error("No action specified in parsed command");
    }

    return validated_response;
  } catch (error) {
    console.error("Error parsing command:", error);

    // Return clarification needed
    return {
      action: "help",
      needsClarification: true,
      clarificationQuestion:
        "I didn't quite understand that. Could you rephrase? Try '/help' to see available commands.",
    };
  }
}

// Clarification Prompt
// const clarification_prompt = fill_prompt(CLARIFICATION_PROMPT, {});

// name suggestion prompt
// const name_suggestion_prompt = fill_prompt(NAME_SUGGESTION_PROMPT, {});

// cost explanation prompt
// const cost_eplanation_prompt = fill_prompt(COST_EXPLANATION_PROMPT, {});

// error explanation prompt
// const error_planation_prompt = fill_prompt(ERROR_EXPLANATION_PROMPT, {});
