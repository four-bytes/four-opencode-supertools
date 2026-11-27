// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import { lookupSymfonyEvents } from '../lib/framework/symfony-events';

export const symfonyEventsTool = tool({
  description:
    'List Symfony event listeners for an event, sorted by priority (class::method prio). Uses debug:event-dispatcher --format=json, with a static tag/getSubscribedEvents fallback marked incomplete.',

  args: {
    event: tool.schema.string().describe('Event name, e.g. kernel.request'),
    limit: tool.schema
      .number()
      .optional()
      .default(50)
      .describe('Maximum listeners to return (default: 50)'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Project directory to inspect (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const start = (args.directory as string | undefined) ?? ctx.directory;
    const framework = detectFramework(start);

    if (framework.framework === 'none' || !framework.root) {
      return {
        title: 'Symfony Events',
        output: JSON.stringify({
          available: false,
          source: 'static',
          incomplete: true,
          event: args.event,
          count: 0,
          total: 0,
          listeners: [],
          truncated: false,
          hint: 'No Symfony/Shopware composer.json found above this path.',
        }),
        metadata: { available: false },
      };
    }

    const result = await lookupSymfonyEvents({
      root: framework.root,
      event: args.event,
      limit: args.limit,
      consolePath: framework.consolePath,
    });

    logDebugEvent('symfony_events.complete', {
      root: framework.root,
      event: args.event,
      source: result.source,
      count: result.count,
      total: result.total,
    });

    return {
      title: 'Symfony Events',
      output: JSON.stringify(result),
      metadata: {
        source: result.source,
        event: args.event,
        count: result.count,
        total: result.total,
        incomplete: result.incomplete ?? false,
      },
    };
  },
});
