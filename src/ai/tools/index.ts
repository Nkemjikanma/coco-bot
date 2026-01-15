// src/agent/tools/index.ts

import type { ToolDefinition } from "../types";
import { actionTools } from "./actionTools";
import { readTools } from "./readTools";
import { writeTools } from "./writeTools";

// ============================================================
// ALL TOOLS
// ============================================================

export const allTools: ToolDefinition[] = [
  ...readTools,
  ...writeTools,
  ...actionTools,
];

// ============================================================
// TOOL MAP (for quick lookup by name)
// ============================================================

export const toolMap: Map<string, ToolDefinition> = new Map(
  allTools.map((tool) => [tool.name, tool]),
);

// ============================================================
// GET TOOL BY NAME
// ============================================================

export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name);
}

// ============================================================
// TOOL NAMES (for allowedTools config)
// ============================================================

export const toolNames = allTools.map((tool) => tool.name);

// ============================================================
// CONVERT TO ANTHROPIC TOOL FORMAT
// ============================================================

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export function toAnthropicTools(): AnthropicTool[] {
  return allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  }));
}

// ============================================================
// RE-EXPORTS
// ============================================================

export { actionTools } from "./actionTools";
export { readTools } from "./readTools";
export { writeTools } from "./writeTools";
