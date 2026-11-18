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
import { solutionConfidenceTool } from './tools/solution-confidence';
import { sonarSearchTool } from './tools/sonar-search';

import { lspReferencesTool } from './tools/lsp-references';
import { lspHoverTool } from './tools/lsp-hover';
import { fileOutlineTool } from './tools/file-outline';
import { extractMethodTool } from './tools/extract-method';
import { renameSymbolTool } from './tools/rename-symbol';
import { moveClassTool } from './tools/move-class';

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
      solution_confidence: solutionConfidenceTool,
      sonar_search: sonarSearchTool,
      lsp_references: lspReferencesTool,
      lsp_hover: lspHoverTool,
      file_outline: fileOutlineTool,
      extract_method: extractMethodTool,
      rename_symbol: renameSymbolTool,
      move_class: moveClassTool,
    },
  };
};

export default FourOpencodeSupertools;
