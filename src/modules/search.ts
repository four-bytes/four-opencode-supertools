// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const searchModule: ModuleDefinition = {
  id: 'search',
  requires: [],
  tools: async () => {
    const { sonarSearchTool } = await import('../tools/sonar-search');
    return { sonar_search: sonarSearchTool };
  },
};
