// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { cropImage, scaleNearest, type Rect } from '../lib/imagelab/image';
import {
  assertRectWithin,
  defaultOutputPath,
  errorMessage,
  failure as failurePayload,
  readImage,
  resolveBase,
  resolveToolPath,
  writeImage,
} from '../lib/imagelab/tool-support';

const TITLE = 'Img Crop Scale';

const DESCRIPTION =
  'Crop a rectangular region from a PNG image and optionally scale it with nearest-neighbour ' +
  'sampling, then write the result.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

export const imgCropScaleTool = tool({
  description: DESCRIPTION,

  args: {
    path: tool.schema.string().describe('Path to the source PNG image.'),
    region: tool.schema
      .object({
        x: tool.schema.number().int().min(0),
        y: tool.schema.number().int().min(0),
        width: tool.schema.number().int().min(1),
        height: tool.schema.number().int().min(1),
      })
      .optional()
      .describe('Region to crop (defaults to the whole image).'),
    scale: tool.schema
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .default(1)
      .describe('Nearest-neighbour scale factor (1..32, default 1).'),
    output: tool.schema
      .string()
      .optional()
      .describe('Output PNG path (default: beside the source image with a ".crop" suffix).'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    try {
      const image = readImage(base, args.path);
      const source = resolveToolPath(base, args.path);
      const rect: Rect = args.region ?? {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
      };
      assertRectWithin(image, rect, 'crop region');

      const cropped = cropImage(image, rect);
      const scale = args.scale ?? 1;
      const result = scale === 1 ? cropped : scaleNearest(cropped, scale);
      const target = args.output ?? defaultOutputPath(base, args.path, '.crop');
      const output = writeImage(base, target, result);

      logDebugEvent('img_crop_scale.complete', {
        sourceWidth: image.width,
        sourceHeight: image.height,
        outputWidth: result.width,
        outputHeight: result.height,
        scale,
      });

      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          path: source,
          source: { width: image.width, height: image.height },
          region: rect,
          scale,
          output: { path: output, width: result.width, height: result.height },
        }),
        metadata: {
          sourceWidth: image.width,
          sourceHeight: image.height,
          outputWidth: result.width,
          outputHeight: result.height,
          scale,
        },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Check that the file is a PNG and the crop region lies inside the image bounds.'
      );
    }
  },
});
