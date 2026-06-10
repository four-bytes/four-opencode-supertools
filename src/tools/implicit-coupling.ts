// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

export const implicitCouplingTool: ToolDefinition = tool({
  description: "Detect files that always change together in the same commit — hidden dependencies invisible in code. Returns co-commit pairs ranked by coupling strength.",
  parameters: {
    threshold: { type: "number", description: "Minimum co-commit rate to report (0.0-1.0, default: 0.8)" },
    since: { type: "string", description: "Only consider commits since date" },
  },
  async execute(_params, _ctx) {
    return "implicit_coupling: not yet implemented";
  },
});
