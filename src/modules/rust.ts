// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// Rust refactoring tools land in a later epic issue (#88).
export const rustModule: ModuleDefinition = {
  id: 'rust',
  requires: ['lsp'],
  tools: async () => ({}),
};
