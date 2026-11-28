// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { parseColour } from '../lib/imagelab/colour';
import { composeImages } from '../lib/imagelab/compose';
import { buildDiffImage } from '../lib/imagelab/diff';
import {
  defaultOutputPath,
  errorMessage,
  failure as failurePayload,
  readImage,
  resolveBase,
  writeImage,
} from '../lib/imagelab/tool-support';

const TITLE = 'Img Diff';

const DESCRIPTION =
  'Pixel-diff two PNG images and write a highlighted diff image. Reports changed pixels, ' +
  'ratios, max/mean delta and changed regions; optionally writes a side-by-side composite ' +
  'of both inputs and the diff.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

export const imgDiffTool = tool({
  description: DESCRIPTION,

  args: {
    a: tool.schema.string().describe('Path to the first (before) PNG image.'),
    b: tool.schema.string().describe('Path to the second (after) PNG image.'),
    output: tool.schema
      .string()
      .optional()
      .describe('Output PNG path (default: beside the first image, ".diff" or ".compose").'),
    threshold: tool.schema
      .number()
      .int()
      .min(0)
      .max(255)
      .optional()
      .default(0)
      .describe('Per-channel delta required to count a pixel as changed (0..255, default 0).'),
    maxRegions: tool.schema
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(20)
      .describe('Maximum changed regions to report (default 20).'),
    highlight: tool.schema
      .string()
      .optional()
      .default('#ff0044')
      .describe('Colour for changed pixels (default #ff0044).'),
    dim: tool.schema
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.35)
      .describe('Brightness factor for unchanged pixels in the diff image (0..1, default 0.35).'),
    sideBySide: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe('Also write a horizontal composite of A, B and the diff (default false).'),
    labels: tool.schema
      .array(tool.schema.string())
      .max(3)
      .optional()
      .describe('Labels for A, B and DIFF in the side-by-side composite.'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    try {
      const a = readImage(base, args.a);
      const b = readImage(base, args.b);
      const { image, result } = buildDiffImage(a, b, {
        threshold: args.threshold ?? 0,
        maxRegions: args.maxRegions ?? 20,
        highlight: parseColour(args.highlight ?? '#ff0044'),
        dim: args.dim ?? 0.35,
      });

      const sizeMismatch = a.width !== b.width || a.height !== b.height;
      const labels = args.labels ?? [];
      const sideBySide = args.sideBySide === true;
      let diffImage: string;

      if (sideBySide) {
        const composed = composeImages(
          [
            { image: a, label: labels[0] ?? 'A' },
            { image: b, label: labels[1] ?? 'B' },
            { image, label: labels[2] ?? 'DIFF' },
          ],
          { layout: 'horizontal', gap: 8 }
        );
        const output = args.output ?? defaultOutputPath(base, args.a, '.compose');
        diffImage = writeImage(base, output, composed.image);
      } else {
        const output = args.output ?? defaultOutputPath(base, args.a, '.diff');
        diffImage = writeImage(base, output, image);
      }

      const truncated = result.regionsTotal > result.regions.length;
      const aSize = { width: a.width, height: a.height };
      const bSize = { width: b.width, height: b.height };

      logDebugEvent('img_diff.complete', {
        changedPixels: result.changedPixels,
        regions: result.regions.length,
        sideBySide,
      });

      const payload: Record<string, unknown> = {
        ok: true,
        a: aSize,
        b: bSize,
        canvas: { width: result.width, height: result.height },
        changedPixels: result.changedPixels,
        totalPixels: result.totalPixels,
        changedRatio: result.changedRatio,
        maxDelta: result.maxDelta,
        meanDelta: result.meanDelta,
        regions: result.regions,
        regionsTotal: result.regionsTotal,
        truncated,
        diffImage,
      };
      if (sizeMismatch) {
        payload.sizeMismatch = { a: aSize, b: bSize };
      }
      if (sideBySide) {
        payload.sideBySide = true;
      }

      return {
        title: TITLE,
        output: JSON.stringify(payload),
        metadata: {
          changedPixels: result.changedPixels,
          regions: result.regions.length,
          sizeMismatch,
        },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Both inputs must be readable PNG files; check the paths and that highlight is a valid colour.'
      );
    }
  },
});
