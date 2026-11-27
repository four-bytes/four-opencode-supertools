// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const symfonyModule: ModuleDefinition = {
  id: 'symfony',
  requires: ['php'],
  tools: async () => {
    const [{ symfonyServiceTool }, { symfonyEventsTool }] = await Promise.all([
      import('../tools/symfony-service'),
      import('../tools/symfony-events'),
    ]);
    return {
      symfony_service: symfonyServiceTool,
      symfony_events: symfonyEventsTool,
    };
  },
};
