// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { Plugin } from '@opencode-ai/plugin';
import { batchEditTool } from './tools/batch-edit';
import { lintFileTool } from './tools/lint-file';
import { runTestsTool } from './tools/run-tests';
import { appendFileTool } from './tools/append-file';

const FourOpencodeSupertools: Plugin = async (_ctx) => {
  return {
    tool: {
      batch_edit: batchEditTool,
      lint_file: lintFileTool,
      run_tests: runTestsTool,
      append_file: appendFileTool,
    },
  };
};

export default FourOpencodeSupertools;
