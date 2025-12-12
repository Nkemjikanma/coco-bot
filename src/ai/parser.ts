import Anthropic from "@anthropic-ai/sdk";
import {
  COMMAND_PARSER_PROMPT,
  CLARIFICATION_PROMPT,
  NAME_SUGGESTION_PROMPT,
  COST_EXPLANATION_PROMPT,
  ERROR_EXPLANATION_PROMPT,
  fill_prompt,
} from "./prompts";
import { getKnowledgeAnswer, GENERAL_QUESTION_PROMPT } from "./knowledge";
import { validate_parse } from "./validators";
import { ParsedCommand, CocoParserResult } from "../types";

import { Message, QuestionCommand, QUESTION_TYPES } from "../types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

export async function coco_parser(
  user_message: string,
  recent_messages: Message[] = [],
): Promise<CocoParserResult> {
  const context = recent_messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  // command parser
  let command_parser = fill_prompt(COMMAND_PARSER_PROMPT, {
    message: user_message,
    context: context || "No recent context",
  });

  let responseText: string;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role: "user", content: command_parser }],
    });

    responseText =
      response.content[0].type === "text" ? response.content[0].text : "";
  } catch (error) {
    // Assume API error - network issue, rate limit, auth failure, etc.
    console.error("Anthropic API error:", error);

    return {
      success: false,
      errorType: "api_error",
      userMessage:
        "Oops! My brain got a little confused. Can you say that again? 🤔",
    };
  }

  // Handle empty response
  if (!responseText || responseText.trim() === "") {
    console.error("Empty response from Anthropic");

    return {
      success: false,
      errorType: "api_error",
      userMessage:
        "Oops! My brain got a little confused. Can you say that again? 🤔",
    };
  }

  const cleanedText = stripMarkdownCodeFences(responseText);

  try {
    const parsed = JSON.parse(cleanedText);

    return {
      success: true,
      parsed,
    };
  } catch (error) {
    // JSON parse failed - Claude returned non-JSON text
    console.error("JSON parse error:", error);
    console.error("Raw response:", responseText);

    return {
      success: false,
      errorType: "invalid_json",
      userMessage:
        "Hmm, I got a bit mixed up trying to understand that. Could you try saying it a different way? 💭",
      rawResponse: responseText,
    };
  }
}

export async function handleQuestionCommand(
  command: QuestionCommand,
): Promise<string> {
  // Try to get a pre-written answer
  const knowledgeAnswer = getKnowledgeAnswer(command.questionType);

  if (knowledgeAnswer) {
    return knowledgeAnswer;
  }

  // For "general" questions, use Claude to generate an answer
  try {
    const prompt = fill_prompt(GENERAL_QUESTION_PROMPT, {
      question: command.questionText,
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const answer =
      response.content[0].type === "text"
        ? response.content[0].text
        : "I'm not sure how to answer that. Could you try asking in a different way?";

    return answer;
  } catch (error) {
    console.error("Error generating answer:", error);
    return "Hmm, I had trouble answering that. Could you try asking in a different way? 🤔";
  }
}
/**
 * Strips markdown code fences from LLM response.
 * Claude sometimes wraps JSON in ```json ... ``` blocks.
 */
function stripMarkdownCodeFences(text: string): string {
  // Remove ```json or ``` at start and ``` at end
  let cleaned = text.trim();

  // Handle ```json\n...\n``` format
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }

  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }

  return cleaned.trim();
}

// Clarification Prompt
// const clarification_prompt = fill_prompt(CLARIFICATION_PROMPT, {});

// name suggestion prompt
// const name_suggestion_prompt = fill_prompt(NAME_SUGGESTION_PROMPT, {});

// cost explanation prompt
// const cost_eplanation_prompt = fill_prompt(COST_EXPLANATION_PROMPT, {});

// error explanation prompt
// const error_planation_prompt = fill_prompt(ERROR_EXPLANATION_PROMPT, {});
