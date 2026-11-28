// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { formatColour } from '../lib/imagelab/colour';
import { getPixel, type Rect } from '../lib/imagelab/image';
import { dominantColours, sampleRegion } from '../lib/imagelab/palette';
import {
  assertRectWithin,
  errorMessage,
  failure as failurePayload,
  readImage,
  resolveBase,
  resolveToolPath,
} from '../lib/imagelab/tool-support';

const TITLE = 'Img Sample';

const DESCRIPTION =
  'Read pixel colours, region statistics and dominant palettes from a PNG image. Sample ' +
  'individual points, rectangular regions or the most common colours of the whole image ' +
  'or a region.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

interface PointOut {
  label?: string;
  x: number;
  y: number;
  hex: string;
  rgba: { r: number; g: number; b: number; a: number };
}

interface RegionOut {
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  uniqueColors: number;
  mean: string;
  dominant: ReturnType<typeof dominantColours>;
}

export const imgSampleTool = tool({
  description: DESCRIPTION,

  args: {
    path: tool.schema.string().describe('Path to the PNG image to sample.'),
    points: tool.schema
      .array(
        tool.schema.object({
          x: tool.schema.number().int().min(0),
          y: tool.schema.number().int().min(0),
          label: tool.schema.string().optional(),
        })
      )
      .max(256)
      .optional()
      .describe('Pixel coordinates to sample as single points.'),
    regions: tool.schema
      .array(
        tool.schema.object({
          x: tool.schema.number().int().min(0),
          y: tool.schema.number().int().min(0),
          width: tool.schema.number().int().min(1),
          height: tool.schema.number().int().min(1),
          label: tool.schema.string().optional(),
        })
      )
      .max(32)
      .optional()
      .describe('Rectangular regions to summarise.'),
    palette: tool.schema
      .object({
        colors: tool.schema.number().int().min(1).max(32).optional().default(8),
        region: tool.schema
          .object({
            x: tool.schema.number().int().min(0),
            y: tool.schema.number().int().min(0),
            width: tool.schema.number().int().min(1),
            height: tool.schema.number().int().min(1),
          })
          .optional(),
      })
      .optional()
      .describe('Dominant-colour palette request; the region defaults to the whole image.'),
    dominant: tool.schema
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .default(5)
      .describe('Dominant colours reported per region (default 5).'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    const hasPoints = Array.isArray(args.points) && args.points.length > 0;
    const hasRegions = Array.isArray(args.regions) && args.regions.length > 0;
    const hasPalette = args.palette !== undefined;

    if (!hasPoints && !hasRegions && !hasPalette) {
      return failure('nothing to sample', 'Provide at least one of points, regions or palette.');
    }

    try {
      const image = readImage(base, args.path);
      const resolved = resolveToolPath(base, args.path);
      const dominantLimit = args.dominant ?? 5;

      const points: PointOut[] = [];
      for (const point of args.points ?? []) {
        assertRectWithin(image, { x: point.x, y: point.y, width: 1, height: 1 }, 'point');
        const pixel = getPixel(image, point.x, point.y);
        const out: PointOut = {
          x: point.x,
          y: point.y,
          hex: formatColour(pixel),
          rgba: pixel,
        };
        if (point.label !== undefined) {
          out.label = point.label;
        }
        points.push(out);
      }

      const regions: RegionOut[] = [];
      for (const region of args.regions ?? []) {
        const rect: Rect = {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        };
        assertRectWithin(image, rect, 'region');
        const sample = sampleRegion(image, rect, dominantLimit);
        const out: RegionOut = {
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
          uniqueColors: sample.uniqueColors,
          mean: sample.mean,
          dominant: sample.dominant,
        };
        if (region.label !== undefined) {
          out.label = region.label;
        }
        regions.push(out);
      }

      let palette:
        | {
            region: Rect;
            sampled: number;
            colors: ReturnType<typeof dominantColours>;
          }
        | undefined;
      if (args.palette) {
        const rect: Rect = args.palette.region ?? {
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        };
        assertRectWithin(image, rect, 'palette region');
        palette = {
          region: rect,
          sampled: rect.width * rect.height,
          colors: dominantColours(image, rect, args.palette.colors ?? 8),
        };
      }

      logDebugEvent('img_sample.complete', {
        points: points.length,
        regions: regions.length,
        paletteColors: palette?.colors.length ?? 0,
      });

      const payload: Record<string, unknown> = {
        ok: true,
        path: resolved,
        size: { width: image.width, height: image.height },
        points,
        regions,
      };
      if (palette) {
        payload.palette = palette;
      }

      return {
        title: TITLE,
        output: JSON.stringify(payload),
        metadata: {
          points: points.length,
          regions: regions.length,
          paletteColors: palette?.colors.length ?? 0,
        },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Check that the file is a PNG and every point/region lies inside the image bounds.'
      );
    }
  },
});
