// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

export const busFactorTool: ToolDefinition = tool({
  description: "Calculate bus factor per directory — ownership concentration analysis. Identifies modules that would be orphaned if key contributors left.",
  parameters: {
    since: { type: "string", description: "Only consider commits since date" },
  },
  async execute(_params, _ctx) {
    return "bus_factor: not yet implemented";
  },
});
