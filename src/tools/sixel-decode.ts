// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { parseColour } from '../lib/imagelab/colour';
import { decodeSixel } from '../lib/imagelab/sixel';
import {
  MAX_TEXT_FILE_BYTES,
  defaultOutputPath,
  errorMessage,
  failure as failurePayload,
  readFileLimited,
  resolveBase,
  resolveToolPath,
  writeImage,
} from '../lib/imagelab/tool-support';

const TITLE = 'Sixel Decode';

const DESCRIPTION =
  'Decode a Sixel image stream from a file or inline data into a PNG. Reports the decoded ' +
  'size, colour bands, declared raster size and the palette that was used.';

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify(failurePayload(error, hint)),
    metadata: { available: true, error: true },
  };
}

export const sixelDecodeTool = tool({
  description: DESCRIPTION,

  args: {
    path: tool.schema
      .string()
      .optional()
      .describe('Path to a file containing a Sixel stream (required when data is omitted).'),
    data: tool.schema
      .string()
      .optional()
      .describe('Inline Sixel stream content (required when path is omitted).'),
    output: tool.schema
      .string()
      .optional()
      .describe(
        'Output PNG path (default: beside the source with ".decoded", or sixel-decoded.png).'
      ),
    background: tool.schema
      .string()
      .optional()
      .describe('Background colour to fill behind the decoded image.'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for relative paths (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const base = resolveBase(args.directory, ctx.directory);
    const hasPath = typeof args.path === 'string';
    const hasData = typeof args.data === 'string';

    if (hasPath === hasData) {
      return failure(
        'exactly one of path or data is required',
        'Pass path to a Sixel file, or data with the stream content.'
      );
    }

    try {
      let input: Uint8Array | string;
      if (hasPath) {
        input = readFileLimited(
          resolveToolPath(base, args.path as string),
          MAX_TEXT_FILE_BYTES,
          'sixel stream'
        );
      } else {
        const data = args.data as string;
        if (Buffer.byteLength(data, 'utf8') > MAX_TEXT_FILE_BYTES) {
          throw new Error(`sixel stream exceeds ${MAX_TEXT_FILE_BYTES} bytes`);
        }
        input = data;
      }
      const decoded = decodeSixel(
        input,
        args.background ? { background: parseColour(args.background) } : undefined
      );

      const target =
        args.output ??
        (hasPath ? defaultOutputPath(base, args.path as string, '.decoded') : 'sixel-decoded.png');
      const output = writeImage(base, target, decoded.image);

      logDebugEvent('sixel_decode.complete', {
        width: decoded.width,
        height: decoded.height,
        bands: decoded.bands,
        coloursUsed: decoded.coloursUsed,
      });

      const payload: Record<string, unknown> = {
        ok: true,
        size: { width: decoded.width, height: decoded.height },
        bands: decoded.bands,
        palette: decoded.palette,
        coloursUsed: decoded.coloursUsed,
        output: { path: output, width: decoded.image.width, height: decoded.image.height },
      };
      if (decoded.declared) {
        payload.declared = decoded.declared;
      }

      return {
        title: TITLE,
        output: JSON.stringify(payload),
        metadata: {
          width: decoded.width,
          height: decoded.height,
          bands: decoded.bands,
          coloursUsed: decoded.coloursUsed,
        },
      };
    } catch (error) {
      return failure(
        errorMessage(error),
        'Provide a valid Sixel stream via exactly one of path or data.'
      );
    }
  },
});
