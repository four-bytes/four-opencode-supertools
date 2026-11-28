// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const shopwareModule: ModuleDefinition = {
  id: 'shopware',
  requires: ['symfony'],
  tools: async () => {
    const { sw6PluginTool } = await import('../tools/sw6-plugin');
    return { sw6_plugin: sw6PluginTool };
  },
};
