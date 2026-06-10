// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

export const curseScoreTool: ToolDefinition = tool({
  description: "Rank files by risk using curse score algorithm: changes × author chaos × recency × churn acceleration. Returns top N most dangerous files in the repo.",
  parameters: {
    top: { type: "number", description: "Number of files to return (default: 10)" },
    since: { type: "string", description: "Only consider commits since date (e.g., '90d', '6m', '2024-01-01')" },
  },
  async execute(_params, _ctx) {
    return "curse_score: not yet implemented";
  },
});
