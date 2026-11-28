// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { collectSkinPairs, contrastEntry, type ContrastPair } from '../lib/imagelab/contrast';
import {
  MAX_TEXT_FILE_BYTES,
  errorMessage,
  failure as failurePayload,
  readFileLimited,
  resolveBase,
  resolveToolPath,
} from '../lib/imagelab/tool-support';

const TITLE = 'Contrast Check';

const DESCRIPTION =
  'Check WCAG contrast ratios for explicit foreground/background colour pairs and/or colour ' +
  'pairs extracted from a JSON skin or theme file. Reports AA, AAA and large-text pass flags.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

export const contrastCheckTool = tool({
  description: DESCRIPTION,

  args: {
    pairs: tool.schema
      .array(
        tool.schema.object({
          label: tool.schema.string().optional(),
          foreground: tool.schema.string(),
          background: tool.schema.string(),
        })
      )
      .max(200)
      .optional()
      .describe('Explicit colour pairs to score.'),
    skin: tool.schema
      .string()
      .optional()
      .describe(
        'Path to a JSON file containing fg/bg or text/background keys to extract pairs from.'
      ),
    background: tool.schema
      .string()
      .optional()
      .default('#000000')
      .describe('Fallback background for extracted skin pairs (default #000000).'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    const hasPairs = Array.isArray(args.pairs) && args.pairs.length > 0;
    const hasSkin = typeof args.skin === 'string' && args.skin.length > 0;

    if (!hasPairs && !hasSkin) {
      return failure(
        'no colour pairs provided',
        'Provide pairs with foreground/background fields, or a skin JSON file.'
      );
    }

    const background = args.background ?? '#000000';

    try {
      const combined: ContrastPair[] = [...(args.pairs ?? [])];

      if (hasSkin) {
        const jsonPath = resolveToolPath(base, args.skin as string);
        const json: unknown = JSON.parse(
          readFileLimited(jsonPath, MAX_TEXT_FILE_BYTES, 'skin JSON').toString('utf8')
        );
        const skinPairs = collectSkinPairs(json, background);
        if (skinPairs.length > 0) {
          combined.push(...skinPairs);
        }
      }

      if (combined.length === 0) {
        return failure(
          'no colour pairs found',
          'Use foreground/background fields, or include fg/bg/text/background keys in the skin JSON.'
        );
      }

      const entries = combined.map((pair) => contrastEntry(pair));
      const failed = entries.filter((entry) => entry.aa === false).length;

      logDebugEvent('contrast_check.complete', {
        total: entries.length,
        failed,
      });

      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          total: entries.length,
          failed,
          pairs: entries,
        }),
        metadata: { total: entries.length, failed },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Check that the skin file is valid JSON and every colour is a valid hex/rgba value.'
      );
    }
  },
});
