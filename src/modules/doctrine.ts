// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// Doctrine tools land in a later epic issue (#90).
export const doctrineModule: ModuleDefinition = {
  id: 'doctrine',
  requires: ['symfony'],
  tools: async () => ({}),
};
