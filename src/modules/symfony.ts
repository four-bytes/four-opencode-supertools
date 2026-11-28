// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const symfonyModule: ModuleDefinition = {
  id: 'symfony',
  requires: ['php'],
  tools: async () => {
    const [{ symfonyServiceTool }, { symfonyEventsTool }, { twigBlocksTool }] = await Promise.all([
      import('../tools/symfony-service'),
      import('../tools/symfony-events'),
      import('../tools/twig-blocks'),
    ]);
    return {
      symfony_service: symfonyServiceTool,
      symfony_events: symfonyEventsTool,
      twig_blocks: twigBlocksTool,
    };
  },
};
