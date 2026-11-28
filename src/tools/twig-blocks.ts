// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework } from '../lib/framework/detect';
import { DEFAULT_TWIG_MAX_FILES, loadSupertoolsConfig } from '../lib/framework/config';
import { buildTemplateChain, resolveLoaderPaths } from '../lib/twig/resolver';
import { buildBlockChain } from '../lib/twig/blocks';
import { discoverCustomTags } from '../lib/twig/custom-tags';

const UNKNOWN_TAG_HINT = 'Unmapped Twig tag; map it in .supertools.json under twig.tags';

export const twigBlocksTool = tool({
  description:
    'Show the Twig override chain for a block or template: extends, block, parent(), use, embed and include with path:line. Auto-detects custom inheritance tags and honours .supertools.json twig.tags. Uses debug:twig --format=json, with a static config/packages/twig.yaml fallback marked incomplete.',

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

    const config = loadSupertoolsConfig(framework.root);
    let configTags: Readonly<Record<string, string>> = {};
    let includeVendor = false;
    let maxFiles = DEFAULT_TWIG_MAX_FILES;
    let configError: string | undefined;

    if (config.ok) {
      configTags = config.config.twig.tags;
      includeVendor = config.config.twig.discovery.vendor;
      maxFiles = config.config.twig.discovery.maxFiles;
    } else {
      configError = config.error;
      logDebugEvent('twig_blocks.config_error', {
        root: framework.root,
        error: config.error,
        key: config.key,
      });
    }

    const discovery = await discoverCustomTags({
      root: framework.root,
      includeVendor,
      maxFiles,
    });
    // Config wins over auto-detection; built-ins are the fallback in the scanner.
    const tagMap: Record<string, string> = { ...discovery.tags, ...configTags };

    const loaders = await resolveLoaderPaths({
      root: framework.root,
      consolePath: framework.consolePath,
    });

    const discoveryMetadata = {
      customTags: Object.keys(discovery.tags).length,
      configTags: Object.keys(configTags).length,
      discoveryIncomplete: discovery.incomplete,
    };

    const withHints = (
      result: Record<string, unknown>,
      unknownTags: number
    ): Record<string, unknown> => {
      const output: Record<string, unknown> = { ...result };
      if (configError) output.configError = configError;
      if (unknownTags > 0) output.hint = UNKNOWN_TAG_HINT;
      return output;
    };

    if (mode === 'template') {
      const result = buildTemplateChain(args.name, loaders, framework.root, { tagMap });
      const count = result.blocks.length;
      const output = withHints(
        result as unknown as Record<string, unknown>,
        result.unknownTags.length
      );

      logDebugEvent('twig_blocks.complete', {
        root: framework.root,
        mode,
        name: args.name,
        source: loaders.source,
        count,
        total: count,
        ...discoveryMetadata,
      });

      return {
        title: 'Twig Blocks',
        output: JSON.stringify(output),
        metadata: {
          available: true,
          source: loaders.source,
          mode,
          count,
          total: count,
          incomplete: loaders.incomplete || discovery.incomplete,
          unknownTags: result.unknownTags.length,
          ...discoveryMetadata,
        },
      };
    }

    const result = buildBlockChain(args.name, loaders, framework.root, {
      limit: args.limit,
      template: args.template,
      tagMap,
    });
    const output = withHints(
      result as unknown as Record<string, unknown>,
      result.unknownTags.length
    );

    logDebugEvent('twig_blocks.complete', {
      root: framework.root,
      mode,
      name: args.name,
      template: args.template,
      source: loaders.source,
      count: result.count,
      total: result.total,
      ...discoveryMetadata,
    });

    return {
      title: 'Twig Blocks',
      output: JSON.stringify(output),
      metadata: {
        available: true,
        source: loaders.source,
        mode,
        count: result.count,
        total: result.total,
        incomplete: loaders.incomplete || discovery.incomplete,
        unknownTags: result.unknownTags.length,
        ...discoveryMetadata,
      },
    };
  },
});
