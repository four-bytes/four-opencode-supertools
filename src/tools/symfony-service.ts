// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import { lookupSymfonyServices } from '../lib/framework/symfony-services';

export const symfonyServiceTool = tool({
  description:
    'Look up a Symfony service by id or class: class, arguments, tags, decorators and alias. Uses debug:container --format=json, with a static config/services fallback marked incomplete.',

  args: {
    service: tool.schema
      .string()
      .optional()
      .describe('Service id, FQCN, partial id, or tag:<name>'),
    tag: tool.schema.string().optional().describe('Only services carrying this tag'),
    limit: tool.schema
      .number()
      .optional()
      .default(20)
      .describe('Maximum services to return (default: 20)'),
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
        title: 'Symfony Service',
        output: JSON.stringify({
          available: false,
          source: 'static',
          incomplete: true,
          query: args.service ?? '',
          count: 0,
          total: 0,
          services: [],
          truncated: false,
          hint: 'No Symfony/Shopware composer.json found above this path.',
        }),
        metadata: { available: false },
      };
    }

    const result = await lookupSymfonyServices({
      root: framework.root,
      query: args.service,
      tag: args.tag,
      limit: args.limit,
      consolePath: framework.consolePath,
    });

    logDebugEvent('symfony_service.complete', {
      root: framework.root,
      source: result.source,
      count: result.count,
      total: result.total,
    });

    return {
      title: 'Symfony Service',
      output: JSON.stringify(result),
      metadata: {
        source: result.source,
        count: result.count,
        total: result.total,
        incomplete: result.incomplete ?? false,
      },
    };
  },
});
