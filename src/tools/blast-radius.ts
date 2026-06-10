// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

export const blastRadiusTool: ToolDefinition = tool({
  description: "Given a file, find everything that might break when you touch it — coupled files, shared authors, related modules.",
  parameters: {
    file: { type: "string", description: "File path relative to repo root to analyze" },
    since: { type: "string", description: "Only consider commits since date" },
  },
  async execute(_params, _ctx) {
    return "blast_radius: not yet implemented";
  },
});
