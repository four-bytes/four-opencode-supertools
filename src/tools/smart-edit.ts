// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { logDebugEvent } from '../lib/debug-logger';

export const smartEditTool = tool({
  description: `Replace text in a file with whitespace-tolerant fuzzy matching. Tries exact match first, then retries with normalized whitespace per line. Use when native edit fails due to indentation variance.`,

  args: {
    file_path: tool.schema
      .string()
      .describe('Absolute path to the file'),
    old_string: tool.schema
      .string()
      .describe('Text to find and replace'),
    new_string: tool.schema
      .string()
      .describe('Replacement text'),
    allow_multiple: tool.schema
      .boolean()
      .optional()
      .describe('If false (default), error when >1 match found. If true, replace all matches.'),
  },

  async execute(args, _ctx) {
    const { file_path, old_string, new_string, allow_multiple } = args;

    logDebugEvent('smart_edit.start', { file_path, old_string: old_string.substring(0, 40) });

    if (!existsSync(file_path)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const content = readFileSync(file_path, 'utf-8');
    const lines = content.split('\n');
    const oldLines = old_string.split('\n');

    // Normalize: trim leading whitespace per line
    const normalizeLine = (s: string) => s.replace(/^[ \t]+/, '');
    const normalizeBlock = (s: string) => s.split('\n').map(normalizeLine).join('\n');

    // Count exact matches
    const exactMatches = content.split(old_string).length - 1;
    if (exactMatches > 0) {
      if (exactMatches > 1 && !allow_multiple) {
        logDebugEvent('smart_edit.multiple_exact', { file_path, matchCount: exactMatches });
        throw new Error(
          `Found ${exactMatches} exact matches. Set allow_multiple=true to replace all, or narrow your search.`
        );
      }

      const newContent = allow_multiple
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);
      writeFileSync(file_path, newContent, 'utf-8');
      const firstLine = content.substring(0, content.indexOf(old_string)).split('\n').length;
      logDebugEvent('smart_edit.complete', { file_path, method: 'exact', matches: exactMatches });
      return { changed: true, line: firstLine, matches: exactMatches, method: 'exact' };
    }

    // Try normalized match
    const normalizedOld = normalizeBlock(old_string);
    let matchCount = 0;
    let firstMatchLine = -1;
    const candidateLines: number[] = [];

    for (let i = 0; i <= lines.length - oldLines.length; i++) {
      const slice = lines.slice(i, i + oldLines.length);
      const normalizedSlice = slice.map(normalizeLine).join('\n');
      if (normalizedSlice === normalizedOld) {
        if (matchCount === 0) firstMatchLine = i + 1;
        matchCount++;
        candidateLines.push(i + 1);
      }
    }

    if (matchCount === 0) {
      logDebugEvent('smart_edit.not_found', { file_path });
      throw new Error(`Text not found in ${file_path} (tried exact and whitespace-normalized match)`);
    }

    if (matchCount > 1 && !allow_multiple) {
      logDebugEvent('smart_edit.multiple_matches', { file_path, matchCount });
      throw new Error(
        `Found ${matchCount} matches. Set allow_multiple=true to replace all, or narrow your search. Candidates at lines: ${candidateLines.join(', ')}`
      );
    }

    // Apply replacement — work bottom-up to preserve line indices
    let resultLines = [...lines];
    for (let i = resultLines.length - oldLines.length; i >= 0; i--) {
      const slice = resultLines.slice(i, i + oldLines.length);
      const normalizedSlice = slice.map(normalizeLine).join('\n');
      if (normalizedSlice === normalizedOld) {
        const newLines = new_string.split('\n');
        resultLines.splice(i, oldLines.length, ...newLines);
      }
    }

    writeFileSync(file_path, resultLines.join('\n'), 'utf-8');
    logDebugEvent('smart_edit.complete', { file_path, method: 'normalized', matches: matchCount });
    return { changed: true, line: firstMatchLine, matches: matchCount, method: 'normalized' };
  },
});
