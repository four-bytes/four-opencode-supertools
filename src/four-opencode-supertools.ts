// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { Plugin } from '@opencode-ai/plugin';
import { applyPatchTool } from './tools/apply-patch';
import { batchEditTool } from './tools/batch-edit';
import { lintFileTool } from './tools/lint-file';
import { runTestsTool } from './tools/run-tests';
import { curseScoreTool } from './tools/curse-score';
import { busFactorTool } from './tools/bus-factor';
import { implicitCouplingTool } from './tools/implicit-coupling';
import { ownershipTool } from './tools/ownership';
import { blastRadiusTool } from './tools/blast-radius';

const FourOpencodeSupertools: Plugin = async (_ctx) => {
  return {
    tool: {
      patch_file: applyPatchTool,
      batch_edit: batchEditTool,
      lint_file: lintFileTool,
      run_tests: runTestsTool,
      curse_score: curseScoreTool,
      bus_factor: busFactorTool,
      implicit_coupling: implicitCouplingTool,
      ownership: ownershipTool,
      blast_radius: blastRadiusTool,
    },
  };
};

export default FourOpencodeSupertools;
