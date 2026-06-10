import type { DiffHunk } from './diff-parse';

/**
 * Apply parsed diff hunks to original file content.
 * Returns the modified file content as a string.
 */
export function applyHunks(hunks: DiffHunk[], originalContent: string): string {
  const originalLines = originalContent.split('\n');
  const result: string[] = [];
  let origIdx = 0;

  for (const hunk of hunks) {
    // Copy lines before this hunk's start
    while (origIdx < hunk.oldStart - 1) {
      result.push(originalLines[origIdx] ?? '');
      origIdx++;
    }

    // Apply hunk lines
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        result.push(line.content);
        origIdx++;
      } else if (line.type === 'remove') {
        origIdx++; // Skip this line in original
      } else if (line.type === 'add') {
        result.push(line.content);
        // Don't advance origIdx for adds
      }
    }
  }

  // Copy remaining lines after last hunk
  while (origIdx < originalLines.length) {
    result.push(originalLines[origIdx]);
    origIdx++;
  }

  return result.join('\n');
}

/**
 * Generate a summary of what the diff changes.
 */
export function summarizeChanges(
  hunks: DiffHunk[]
): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      if (line.type === 'remove') removed++;
    }
  }

  return { added, removed, files: hunks.length > 0 ? 1 : 0 };
}
