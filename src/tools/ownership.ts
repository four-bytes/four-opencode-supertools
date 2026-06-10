// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";

export const ownershipTool: ToolDefinition = tool({
  description: "Analyze who owns the lines alive in HEAD — per-file and per-directory author breakdown. Surfaces knowledge silos and onboarding targets.",
  parameters: {
    path: { type: "string", description: "File or directory path relative to repo root (default: entire repo)" },
  },
  async execute(_params, _ctx) {
    return "ownership: not yet implemented";
  },
});
