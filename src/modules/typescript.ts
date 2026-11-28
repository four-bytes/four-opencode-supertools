// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// TypeScript/JavaScript linting and tests live in lint_file and run_tests (#107).
// This module additionally provides rename_symbol via the LSP (#85).
export const typescriptModule: ModuleDefinition = {
  id: 'typescript',
  requires: ['lsp'],
  tools: async ({ modules }) => {
    const { createRenameSymbolTool } = await import('../tools/rename-symbol');
    return {
      rename_symbol: createRenameSymbolTool({ modules }),
    };
  },
};
