// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';

/**
 * Produce a Claude-style diff block showing changed lines with context.
 * Format:
 *   ● Update(filePath)
 *     ⎿  Added X lines, removed Y lines
 *         <lineNum>  <context_line>
 *         <lineNum> -<removed_line>
 *         <lineNum> +<added_line>
 */
function formatDiff(
  filePath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxLen = Math.max(oldLines.length, newLines.length);

  // Find first and last differing lines
  let firstDiff = -1;
  let lastDiff = -1;
  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;
    if (oldLine !== newLine) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }

  if (firstDiff === -1) {
    return `● Update(${filePath})\n  ⎿  No changes detected\n`;
  }

  // Compute added/removed counts in the diff region
  let added = 0;
  let removed = 0;
  const contextLines = 2;
  const start = Math.max(0, firstDiff - contextLines);
  const end = Math.min(maxLen, lastDiff + 1 + contextLines);

  // Build a simple line-by-line alignment
  interface DiffLine {
    kind: 'context' | 'removed' | 'added';
    oldNum?: number;
    newNum?: number;
    text: string;
  }

  const diff: DiffLine[] = [];
  let oi = start;
  let ni = start;

  while (oi < end || ni < end) {
    const oldLine = oi < oldLines.length ? oldLines[oi] : undefined;
    const newLine = ni < newLines.length ? newLines[ni] : undefined;

    if (oi >= end && ni >= end) break;

    if (oldLine === newLine) {
      // Context line
      diff.push({ kind: 'context', oldNum: oi + 1, newNum: ni + 1, text: oldLine! });
      oi++;
      ni++;
    } else {
      // Try to align: skip removed lines first
      if (oldLine !== undefined && (oi < firstDiff || oi <= lastDiff)) {
        diff.push({ kind: 'removed', oldNum: oi + 1, text: oldLine });
        removed++;
        oi++;
        continue;
      }
      if (newLine !== undefined && (ni < firstDiff || ni <= lastDiff)) {
        diff.push({ kind: 'added', newNum: ni + 1, text: newLine });
        added++;
        ni++;
        continue;
      }
      // Fallback: advance both
      oi++;
      ni++;
    }
  }

  // Format output
  const header = `● Update(${filePath})\n  ⎿  Added ${added} lines, removed ${removed} lines\n`;
  const body = diff.map((d) => {
    const num = d.kind === 'added' ? d.newNum! : d.oldNum!;
    const prefix = d.kind === 'removed' ? '-' : d.kind === 'added' ? '+' : ' ';
    return `      ${String(num).padStart(4)} ${prefix}${d.text}`;
  }).join('\n');

  return header + body;
}

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

    const originalContent = readFileSync(file_path, 'utf-8');
    const lines = originalContent.split('\n');
    const oldLines = old_string.split('\n');

    // Normalize: trim leading whitespace per line
    const normalizeLine = (s: string) => s.replace(/^[ \t]+/, '');
    const normalizeBlock = (s: string) => s.split('\n').map(normalizeLine).join('\n');

    let matchCount = 0;
    let firstMatchLine = -1;
    let method: 'exact' | 'normalized' = 'exact';

    // ── Exact match ──
    const exactMatches = originalContent.split(old_string).length - 1;
    if (exactMatches > 0) {
      if (exactMatches > 1 && !allow_multiple) {
        logDebugEvent('smart_edit.multiple_exact', { file_path, matchCount: exactMatches });
        throw new Error(
          `Found ${exactMatches} exact matches. Set allow_multiple=true to replace all, or narrow your search.`
        );
      }

      const newContent = allow_multiple
        ? originalContent.replaceAll(old_string, new_string)
        : originalContent.replace(old_string, new_string);
      writeFileSync(file_path, newContent, 'utf-8');
      firstMatchLine = originalContent.substring(0, originalContent.indexOf(old_string)).split('\n').length;
      matchCount = exactMatches;
      method = 'exact';
    } else {
      // ── Normalized match ──
      const normalizedOld = normalizeBlock(old_string);
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
      // FIXED: was comparing normalizedSlice === normalizedSlice (same var — always true!)
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
      method = 'normalized';
    }

    logDebugEvent('smart_edit.complete', { file_path, method, matches: matchCount });

    // Read back the new content and produce Claude-style diff
    const newContent = readFileSync(file_path, 'utf-8');
    const diffOutput = formatDiff(file_path, originalContent, newContent);

    return {
      title: `Updated ${basename(file_path)}`,
      output: diffOutput,
      metadata: {
        changed: true,
        line: firstMatchLine,
        matches: matchCount,
        method,
      },
    };
  },
});
