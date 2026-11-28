// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { parseColour } from '../lib/imagelab/colour';
import { composeImages, type ComposeLayout } from '../lib/imagelab/compose';
import {
  errorMessage,
  failure as failurePayload,
  readImage,
  resolveBase,
  writeImage,
} from '../lib/imagelab/tool-support';

const TITLE = 'Img Compose';

const DESCRIPTION =
  'Compose up to eight PNG images into a horizontal strip, vertical stack or grid, with ' +
  'optional labels, gaps, background colour and pixel scaling, then write the result.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

interface PanelOut {
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const imgComposeTool = tool({
  description: DESCRIPTION,

  args: {
    inputs: tool.schema
      .array(
        tool.schema.object({
          path: tool.schema.string(),
          label: tool.schema.string().optional(),
        })
      )
      .min(1)
      .max(8)
      .describe('Images to compose (1..8), each with an optional label.'),
    layout: tool.schema
      .enum(['horizontal', 'vertical', 'grid'])
      .optional()
      .default('horizontal')
      .describe('Composition layout (default horizontal).'),
    columns: tool.schema
      .number()
      .int()
      .min(1)
      .max(8)
      .optional()
      .describe('Grid columns (defaults to ceil(sqrt(count))).'),
    gap: tool.schema
      .number()
      .int()
      .min(0)
      .max(128)
      .optional()
      .default(8)
      .describe('Gap between panels in pixels (default 8).'),
    background: tool.schema
      .string()
      .optional()
      .default('#101010')
      .describe('Background colour (default #101010).'),
    labelHeight: tool.schema
      .number()
      .int()
      .min(0)
      .max(64)
      .optional()
      .default(12)
      .describe('Height reserved above each panel for its label (default 12).'),
    labelScale: tool.schema
      .number()
      .int()
      .min(1)
      .max(4)
      .optional()
      .default(1)
      .describe('Text scale for labels (default 1).'),
    scale: tool.schema
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .default(1)
      .describe('Nearest-neighbour scale factor applied to every panel (default 1).'),
    output: tool.schema
      .string()
      .optional()
      .describe('Output PNG path (default: "imagelab-compose.png" in the base directory).'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    const inputs = args.inputs ?? [];

    if (inputs.length === 0) {
      return failure('no inputs', 'Provide at least one image in inputs.');
    }

    try {
      const panels = inputs.map((input) => ({
        image: readImage(base, input.path),
        label: input.label,
      }));
      const layout: ComposeLayout = args.layout ?? 'horizontal';
      const result = composeImages(panels, {
        layout,
        columns: args.columns,
        gap: args.gap ?? 8,
        background: parseColour(args.background ?? '#101010'),
        labelHeight: args.labelHeight ?? 12,
        labelScale: args.labelScale ?? 1,
        scale: args.scale ?? 1,
      });

      const target = args.output ?? 'imagelab-compose.png';
      const output = writeImage(base, target, result.image);
      const labels = inputs.some((input) => typeof input.label === 'string');

      const placements: PanelOut[] = result.placements.map((placement) => {
        const panel: PanelOut = {
          x: placement.x,
          y: placement.y,
          width: placement.width,
          height: placement.height,
        };
        if (placement.label !== undefined) {
          panel.label = placement.label;
        }
        return panel;
      });

      logDebugEvent('img_compose.complete', {
        panels: panels.length,
        width: result.image.width,
        height: result.image.height,
        labels,
      });

      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          output,
          width: result.image.width,
          height: result.image.height,
          layout,
          columns: result.columns,
          gap: args.gap ?? 8,
          labels,
          panels: placements,
        }),
        metadata: {
          panels: panels.length,
          width: result.image.width,
          height: result.image.height,
          labels,
        },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Check that every input is a readable PNG and the composed canvas stays within limits.'
      );
    }
  },
});
