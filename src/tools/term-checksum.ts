// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';
import { readTraceFile } from '../lib/termlab/trace';
import {
  CHECKSUM_ALGORITHM,
  checksumFromFrame,
  checksumFromText,
  decrqcraQuery,
  escapeBytes,
  parseChecksumResponse,
} from '../lib/termlab/checksum';

const TITLE = 'Term Checksum';
const MODES = ['compute', 'query', 'parse', 'trace'] as const;
type Mode = (typeof MODES)[number];

const DESCRIPTION =
  'DECRQCRA checksum helper (utf16-sum-mod-65536). compute: checksum a text screen dump. trace: checksum a trace frame back buffer. query: emit the DECRQCRA request sequence. parse: parse a DECCKSR checksum response.';

function failure(error: string, hint: string, available = true) {
  return {
    title: TITLE,
    output: JSON.stringify({ available, algorithm: CHECKSUM_ALGORITHM, error, hint }),
    metadata: { available, error: true },
  };
}

export const termChecksumTool = tool({
  description: DESCRIPTION,

  args: {
    mode: tool.schema
      .enum(MODES)
      .optional()
      .default('compute')
      .describe('compute | trace | query | parse (default: compute).'),
    text: tool.schema
      .string()
      .optional()
      .describe('Screen dump for mode compute (lines split on newline).'),
    path: tool.schema.string().optional().describe('Trace file path for mode trace.'),
    response: tool.schema.string().optional().describe('DECCKSR response string for mode parse.'),
    frame: tool.schema
      .number()
      .int()
      .optional()
      .default(1)
      .describe('Frame number for mode trace (default: 1).'),
    region: tool.schema
      .object({
        x: tool.schema.number().int().min(0),
        y: tool.schema.number().int().min(0),
        width: tool.schema.number().int().min(1),
        height: tool.schema.number().int().min(1),
      })
      .optional()
      .describe('0-based half-open region {x,y,width,height} (default: full grid).'),
    page: tool.schema.number().int().optional().default(1).describe('Page number for mode query.'),
    id: tool.schema
      .number()
      .int()
      .optional()
      .default(1)
      .describe('Request id for mode query/parse.'),
    directory: tool.schema
      .string()
      .optional()
      .describe('Base directory for a relative path (defaults to the project directory).'),
  },

  async execute(args, ctx) {
    const mode: Mode = args.mode ?? 'compute';

    if (mode === 'compute') {
      if (typeof args.text !== 'string') {
        return failure(
          'text is required for mode compute',
          'Pass text, a screen dump with one line per row.'
        );
      }
      const result = checksumFromText(args.text, args.region);
      logDebugEvent('term_checksum.complete', { mode, cells: result.cells });
      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          mode,
          algorithm: CHECKSUM_ALGORITHM,
          checksum: result.checksum,
          hex: result.hex,
          cells: result.cells,
          width: result.width,
          height: result.height,
          region: result.region,
        }),
        metadata: { mode, cells: result.cells },
      };
    }

    if (mode === 'trace') {
      if (typeof args.path !== 'string') {
        return failure('path is required for mode trace', 'Pass path to a TURBO_TUI_TRACE file.');
      }
      let trace;
      try {
        const base = args.directory ?? ctx.directory;
        trace = readTraceFile(resolve(base, args.path));
      } catch (err) {
        return failure(
          err instanceof Error ? err.message : String(err),
          'The file must be a valid TURBO_TUI_TRACE 1 file.'
        );
      }
      const wanted = args.frame ?? 1;
      const frame =
        trace.frames.find((entry) => entry.number === wanted) ?? trace.frames[wanted - 1];
      if (!frame) {
        const available = trace.frames.map((entry) => entry.number).join(', ');
        return failure(
          `frame ${wanted} not found`,
          available ? `Available frames: ${available}.` : 'The trace contains no frames.'
        );
      }
      const result = checksumFromFrame(frame, args.region);
      logDebugEvent('term_checksum.complete', { mode, cells: result.cells, frame: frame.number });
      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          mode,
          algorithm: CHECKSUM_ALGORITHM,
          frame: frame.number,
          width: frame.width,
          height: frame.height,
          checksum: result.checksum,
          hex: result.hex,
          cells: result.cells,
          region: result.region,
        }),
        metadata: { mode, cells: result.cells, frame: frame.number },
      };
    }

    if (mode === 'query') {
      const region = args.region;
      if (!region) {
        return failure(
          'region is required for mode query',
          'Pass region {x,y,width,height} so the 1-based DECRQCRA coordinates can be derived.'
        );
      }
      const id = args.id ?? 1;
      const page = args.page ?? 1;
      const top = region.y + 1;
      const left = region.x + 1;
      const bottom = region.y + region.height;
      const right = region.x + region.width;
      const bytes = decrqcraQuery({ id, page, top, left, bottom, right });
      const sequence = escapeBytes(bytes);
      const hex = Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      logDebugEvent('term_checksum.complete', { mode, bytes: bytes.length });
      return {
        title: TITLE,
        output: JSON.stringify({
          ok: true,
          mode,
          algorithm: CHECKSUM_ALGORITHM,
          id,
          page,
          region,
          top,
          left,
          bottom,
          right,
          sequence,
          hex,
          bytes: Array.from(bytes),
        }),
        metadata: { mode, bytes: bytes.length },
      };
    }

    // parse
    if (typeof args.response !== 'string') {
      return failure(
        'response is required for mode parse',
        'Pass a DECCKSR response, e.g. ESC P 1 ! ~ 00a1 ESC \\ or ESC [ 1 ; 161 * y.'
      );
    }
    const parsed = parseChecksumResponse(args.response);
    if (!parsed) {
      return failure(
        'could not parse checksum response',
        'Expected ESC P <id> ! ~ <4 hex> ESC \\, BEL-terminated, or ESC [ <id> ; <value> * y.'
      );
    }
    logDebugEvent('term_checksum.complete', { mode });
    return {
      title: TITLE,
      output: JSON.stringify({
        ok: true,
        mode,
        algorithm: CHECKSUM_ALGORITHM,
        id: parsed.id,
        checksum: parsed.checksum,
        hex: parsed.hex,
      }),
      metadata: { mode },
    };
  },
});
