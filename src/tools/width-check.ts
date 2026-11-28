// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool, type ToolContext } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { type TmuxRunner } from '../lib/termlab/tmux';
import { widthReport } from '../lib/termlab/width';
import { measureEmulatorWidths } from '../lib/termlab/width-emulator';

const TITLE = 'Width Check';
const MAX_GRAPHEMES = 500;

const DESCRIPTION =
  'Display width per grapheme under unicode-width, wcwidth and an independent tmux emulator model (em dash, emoji, VS16, CJK). Reports where the selected models disagree, so width assumptions can be settled with evidence. Returns tmux.available:false when tmux is not installed.';

type WidthModelName = 'unicode' | 'wcwidth' | 'tmux';

type WidthCheckContext = ToolContext & { tmuxRunner?: TmuxRunner };

function failure(error: string, hint: string) {
  return {
    title: TITLE,
    output: JSON.stringify({ available: true, error, hint }),
    metadata: { available: true, error: true },
  };
}

interface GraphemeOut {
  grapheme: string;
  unicode?: number;
  wcwidth?: number;
  tmux?: number;
  codepoints?: string[];
  differs?: boolean;
}

export const widthCheckTool = tool({
  description: DESCRIPTION,

  args: {
    text: tool.schema.string().describe('Text to measure, split into grapheme clusters.'),
    models: tool.schema
      .array(tool.schema.enum(['unicode', 'wcwidth', 'tmux']))
      .optional()
      .default(['unicode', 'wcwidth'])
      .describe('Width models to report (default: unicode and wcwidth).'),
    plain: tool.schema
      .boolean()
      .optional()
      .default(false)
      .describe(
        'Only grapheme/width lines, without codepoints and differs flags (default: false).'
      ),
  },

  async execute(args, ctx) {
    const text = args.text;
    if (typeof text !== 'string') {
      return failure(
        'text is required',
        'Pass the string whose grapheme widths should be measured.'
      );
    }

    const models: WidthModelName[] =
      args.models && args.models.length > 0 ? args.models : ['unicode', 'wcwidth'];
    const plain = args.plain === true;

    const report = widthReport(text);
    const truncated = report.graphemes.length > MAX_GRAPHEMES;
    const selected = report.graphemes.slice(0, MAX_GRAPHEMES);

    let tmuxWidths: (number | null)[] | null = null;
    let tmuxProbeErrors = 0;
    if (models.includes('tmux')) {
      const context = ctx as WidthCheckContext | undefined;
      tmuxWidths = await measureEmulatorWidths(
        selected.map((entry) => entry.grapheme),
        { runner: context?.tmuxRunner }
      );
    }

    const graphemes: GraphemeOut[] = selected.map((entry, index) => {
      const out: GraphemeOut = { grapheme: entry.grapheme };
      const values: number[] = [];

      if (models.includes('unicode')) {
        out.unicode = entry.unicode;
        values.push(entry.unicode);
      }
      if (models.includes('wcwidth')) {
        out.wcwidth = entry.wcwidth;
        values.push(entry.wcwidth);
      }
      if (models.includes('tmux') && tmuxWidths !== null) {
        const value = tmuxWidths[index];
        if (value === null) {
          // A failed probe is never reported as width 0.
          tmuxProbeErrors += 1;
        } else if (value !== undefined) {
          out.tmux = value;
          values.push(value);
        }
      }

      if (!plain) {
        out.codepoints = entry.codepoints;
        out.differs = values.length > 1 && new Set(values).size > 1;
      }
      return out;
    });

    const totals: { unicode?: number; wcwidth?: number; tmux?: number } = {};
    if (models.includes('unicode')) totals.unicode = report.total.unicode;
    if (models.includes('wcwidth')) totals.wcwidth = report.total.wcwidth;
    if (models.includes('tmux') && tmuxWidths !== null) {
      let measured = 0;
      let sum = 0;
      for (const width of tmuxWidths) {
        if (width !== null && width !== undefined) {
          sum += Math.max(0, width);
          measured += 1;
        }
      }
      // Omitted entirely when no grapheme could be measured.
      if (measured > 0) totals.tmux = sum;
    }

    const differs = plain
      ? []
      : graphemes.filter((entry) => entry.differs).map((entry) => entry.grapheme);

    logDebugEvent('width_check.complete', {
      graphemes: report.graphemes.length,
      differs: differs.length,
      truncated,
      tmux: tmuxWidths !== null,
    });

    const payload: Record<string, unknown> = {
      ok: true,
      text,
      totals,
      differs,
      graphemes,
      truncated,
    };
    if (models.includes('tmux')) payload.tmuxProbeErrors = tmuxProbeErrors;
    if (models.includes('tmux') && tmuxWidths === null) {
      payload.tmux = {
        available: false,
        hint: 'Install tmux to measure the emulator width',
      };
    }

    return {
      title: TITLE,
      output: JSON.stringify(payload),
      metadata: {
        graphemes: report.graphemes.length,
        differs: differs.length,
        truncated,
      },
    };
  },
});
