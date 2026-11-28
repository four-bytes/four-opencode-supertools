// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const phpModule: ModuleDefinition = {
  id: 'php',
  requires: [],
  tools: async ({ modules }) => {
    const [
      { extractMethodTool },
      { createRenameSymbolTool },
      { moveClassTool },
      { changeRoutePathTool },
    ] = await Promise.all([
      import('../tools/extract-method'),
      import('../tools/rename-symbol'),
      import('../tools/move-class'),
      import('../tools/change-route-path'),
    ]);
    return {
      extract_method: extractMethodTool,
      rename_symbol: createRenameSymbolTool({ modules }),
      move_class: moveClassTool,
      change_route_path: changeRoutePathTool,
    };
  },
};
