// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// TypeScript/JavaScript support lives in lint_file and run_tests (#107). This stub only
// carries the module so it can be selected and auto-detected; any later refactoring tools
// (e.g. rename_symbol via LSP, #85) register here.
export const typescriptModule: ModuleDefinition = {
  id: 'typescript',
  requires: ['lsp'],
  tools: async () => ({}),
};
