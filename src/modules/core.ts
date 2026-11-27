// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const coreModule: ModuleDefinition = {
  id: 'core',
  requires: [],
  tools: async () => {
    const [
      { batchEditTool },
      { lintFileTool },
      { runTestsTool },
      { appendFileTool },
      { smartEditTool },
      { smartPatchTool },
      { batchPatchTool },
      { fileTreeTool },
      { solutionConfidenceTool },
    ] = await Promise.all([
      import('../tools/batch-edit'),
      import('../tools/lint-file'),
      import('../tools/run-tests'),
      import('../tools/append-file'),
      import('../tools/smart-edit'),
      import('../tools/smart-patch'),
      import('../tools/batch-patch'),
      import('../tools/file-tree'),
      import('../tools/solution-confidence'),
    ]);

    return {
      batch_edit: batchEditTool,
      lint_file: lintFileTool,
      run_tests: runTestsTool,
      append_file: appendFileTool,
      smart_edit: smartEditTool,
      smart_patch: smartPatchTool,
      batch_patch: batchPatchTool,
      file_tree: fileTreeTool,
      solution_confidence: solutionConfidenceTool,
    };
  },
};
