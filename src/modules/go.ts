// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// Go refactoring tools land in a later epic issue (#85).
export const goModule: ModuleDefinition = {
  id: 'go',
  requires: ['lsp'],
  tools: async () => ({}),
};
