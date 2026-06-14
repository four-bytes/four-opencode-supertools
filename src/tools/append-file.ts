// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { readFile, writeFile } from 'node:fs/promises';

export const appendFileTool = tool({
  description:
    'Append or prepend text to a file. Use for simple file additions (changelogs, blogs, logs) where unified diff matching is unnecessary. Saves ~95% tokens vs. patch_file for append-only operations.',

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file'),
    content: tool.schema.string().describe('Text to insert into the file'),
    mode: tool.schema.string().optional().describe('"append" (default) or "prepend"'),
    after_line: tool.schema
      .number()
      .optional()
      .describe(
        'For prepend mode: insert after this line number (0-based; 0 = before first line, -1 = before last line, -2 = before second-to-last line, etc.). Negative values use Python-style indexing from the end. Ignored in append mode.'
      ),
  },

  async execute(args, _ctx) {
    logDebugEvent('append_file.start', { file_path: args.file_path, mode: args.mode });

    try {
      const content = await readFile(args.file_path, 'utf-8');
      const mode = args.mode || 'append';

      let newContent: string;
      if (content.length === 0) {
        // Empty file — just write the content
        newContent = args.content;
        if (!newContent.endsWith('\n')) {
          newContent += '\n';
        }
      } else if (mode === 'prepend') {
        const lines = content.split('\n');
        // Normalize: strip trailing empty string from terminal newline so
        // lines.length reflects the true line count regardless of trailing \n
        const hasTrailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
        if (hasTrailingNewline) {
          lines.pop();
        }

        const rawAfterLine = args.after_line;
        let insertPos: number;
        if (rawAfterLine !== undefined && rawAfterLine < 0) {
          // Negative indexing: Python-like, -1 = before last line,
          // -2 = before second-to-last, etc.
          insertPos = Math.max(0, lines.length + rawAfterLine);
        } else {
          // Legacy: 0 = before first line (position 0),
          // N = after line N (position N+1)
          const insertAt = rawAfterLine ?? 0;
          insertPos = insertAt === 0 ? 0 : insertAt + 1;
        }

        const before = lines.slice(0, insertPos);
        const after = lines.slice(insertPos);
        const result = [...before, args.content, ...after];

        // Restore trailing newline if it was present
        if (hasTrailingNewline) {
          result.push('');
        }
        newContent = result.join('\n');
      } else {
        // Append mode
        newContent = content.endsWith('\n')
          ? content + args.content
          : content + '\n' + args.content;
        if (!newContent.endsWith('\n')) {
          newContent += '\n';
        }
      }

      await writeFile(args.file_path, newContent, 'utf-8');
      const lineCount = newContent.split('\n').length;

      logDebugEvent('append_file.done', { file_path: args.file_path, lines: lineCount });
      return `Appended to ${args.file_path} (${mode} mode, ${lineCount} lines total)`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('append_file.error', { error: msg });
      return `Error: ${msg}`;
    }
  },
});
