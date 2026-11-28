// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import { buildTemplateChain, resolveLoaderPaths } from '../lib/twig/resolver';
import { buildBlockChain } from '../lib/twig/blocks';

export const twigBlocksTool = tool({
  description:
    'Show the Twig override chain for a block or template: extends, block, parent(), use, embed and include with path:line. Uses debug:twig --format=json, with a static config/packages/twig.yaml fallback marked incomplete.',

  args: {
    mode: tool.schema
      .enum(['block', 'template'])
      .optional()
      .default('block')
      .describe(
        'block: override chain for a block name; template: outline of a template and its extends chain'
      ),
    name: tool.schema.string().describe('Block name in block mode, template name in template mode'),
    template: tool.schema
      .string()
      .optional()
      .describe('Block mode only: restrict the chain to this template and its ancestors'),
    limit: tool.schema
      .number()
      .optional()
      .default(50)
      .describe('Maximum chain entries to return (default: 50)'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Project directory to inspect (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const start = (args.directory as string | undefined) ?? ctx.directory;
    const framework = detectFramework(start);
    const mode = args.mode;

    if (framework.framework === 'none' || !framework.root) {
      return {
        title: 'Twig Blocks',
        output: JSON.stringify({
          available: false,
          source: 'static',
          incomplete: true,
          mode,
          name: args.name,
          count: 0,
          chain: [],
          unknownTags: [],
          hint: 'No Symfony/Shopware composer.json found above this path.',
        }),
        metadata: { available: false },
      };
    }

    const loaders = await resolveLoaderPaths({
      root: framework.root,
      consolePath: framework.consolePath,
    });

    if (mode === 'template') {
      const result = buildTemplateChain(args.name, loaders, framework.root);
      const count = result.blocks.length;

      logDebugEvent('twig_blocks.complete', {
        root: framework.root,
        mode,
        name: args.name,
        source: loaders.source,
        count,
        total: count,
      });

      return {
        title: 'Twig Blocks',
        output: JSON.stringify(result),
        metadata: {
          available: true,
          source: loaders.source,
          mode,
          count,
          total: count,
          incomplete: loaders.incomplete,
          unknownTags: result.unknownTags.length,
        },
      };
    }

    const result = buildBlockChain(args.name, loaders, framework.root, {
      limit: args.limit,
      template: args.template,
    });

    logDebugEvent('twig_blocks.complete', {
      root: framework.root,
      mode,
      name: args.name,
      template: args.template,
      source: loaders.source,
      count: result.count,
      total: result.total,
    });

    return {
      title: 'Twig Blocks',
      output: JSON.stringify(result),
      metadata: {
        available: true,
        source: loaders.source,
        mode,
        count: result.count,
        total: result.total,
        incomplete: loaders.incomplete,
        unknownTags: result.unknownTags.length,
      },
    };
  },
});
