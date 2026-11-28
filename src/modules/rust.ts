// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const rustModule: ModuleDefinition = {
  id: 'rust',
  requires: ['lsp'],
  tools: async ({ modules }) => {
    const { createRenameSymbolTool } = await import('../tools/rename-symbol');
    return {
      rename_symbol: createRenameSymbolTool({ modules }),
    };
  },
};
