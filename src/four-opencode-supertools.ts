// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { Plugin } from '@opencode-ai/plugin';
import { batchEditTool } from './tools/batch-edit';
import { lintFileTool } from './tools/lint-file';
import { runTestsTool } from './tools/run-tests';
import { appendFileTool } from './tools/append-file';
import { smartEditTool } from './tools/smart-edit';
import { smartPatchTool } from './tools/smart-patch';
import { batchPatchTool } from './tools/batch-patch';
import { fileTreeTool } from './tools/file-tree';
import { researchTool } from './tools/research';
import { solutionConfidenceTool } from './tools/solution-confidence';
import { ghBotReviewTool } from './tools/gh-bot-review';
import { lspReferencesTool } from './tools/lsp-references';

const FourOpencodeSupertools: Plugin = async (_ctx) => {
  return {
    tool: {
      batch_edit: batchEditTool,
      lint_file: lintFileTool,
      run_tests: runTestsTool,
      append_file: appendFileTool,
      smart_edit: smartEditTool,
      smart_patch: smartPatchTool,
      batch_patch: batchPatchTool,
      file_tree: fileTreeTool,
      research: researchTool,
      solution_confidence: solutionConfidenceTool,
      gh_bot_review: ghBotReviewTool,
      lsp_references: lspReferencesTool,
    },
  };
};

export default FourOpencodeSupertools;
