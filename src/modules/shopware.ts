// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

// Shopware tools land in a later epic issue (#90).
export const shopwareModule: ModuleDefinition = {
  id: 'shopware',
  requires: ['symfony'],
  tools: async () => ({}),
};
