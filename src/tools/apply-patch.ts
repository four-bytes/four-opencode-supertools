import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseUnifiedDiff, validateHunks } from '../lib/diff-parse';
import { applyHunks, summarizeChanges } from '../lib/diff-apply';
import { logDebugEvent } from '../lib/debug-logger';

export const applyPatchTool = tool({
  description: `Apply a unified diff patch to a file. Use this for ALL file modifications (add, update, delete) to save tokens compared to full-file write.

The patch must be in standard unified diff format (same as \`diff -u\` output):
  @@ -10,5 +10,7 @@
   unchanged context line
  -removed line
  +added line
   unchanged context line

For new files, use a patch that adds all content:
  @@ -0,0 +1,3 @@
  +line 1
  +line 2
  +line 3

IMPORTANT: Always use this tool instead of \`write\` or \`edit\` when modifying existing files. It saves ~90% output tokens.`,

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file to patch'),
    patch: tool.schema
      .string()
      .describe(
        'Unified diff patch to apply. Must include proper @@ hunk headers with line numbers.'
      ),
  },

  async execute(args, ctx) {
    const { file_path, patch } = args;

    logDebugEvent('patch_file.start', { file_path, patchLength: patch.length });

    try {
      // 1. Parse the diff
      const parsed = parseUnifiedDiff(patch);

      if (parsed.hunks.length === 0) {
        logDebugEvent('patch_file.no_hunks', { file_path });
        return 'Error: Could not parse any hunks from the patch. Ensure the patch uses standard unified diff format with @@ headers.';
      }

      // 2. Handle new file creation
      if (!existsSync(file_path)) {
        // Check if this looks like a new file patch (all hunks start at 0,0)
        const isNewFile = parsed.hunks.every((h) => h.oldStart === 0 && h.oldLines === 0);
        if (isNewFile) {
          // For new files, all content comes from '+' lines
          const newContent = applyHunks(parsed.hunks, '');
          writeFileSync(file_path, newContent, 'utf-8');

          const { added } = summarizeChanges(parsed.hunks);
          logDebugEvent('patch_file.new_file', { file_path, added });
          return `Created new file with ${added} lines: ${file_path}`;
        }

        return `Error: File does not exist: ${file_path}. For new files, use a patch starting with @@ -0,0 +1,N @@`;
      }

      // 3. Read current file content
      const originalContent = readFileSync(file_path, 'utf-8');
      const originalLines = originalContent.split('\n').length;

      // 4. Validate hunks against current file
      const validationError = validateHunks(parsed.hunks, originalContent);
      if (validationError) {
        logDebugEvent('patch_file.validation_error', { file_path, error: validationError });
        return `Error: Patch validation failed for ${file_path}:\n${validationError}\n\nThe file may have changed since you last read it. Re-read the file and regenerate the patch.`;
      }

      // 5. Apply the patch
      const newContent = applyHunks(parsed.hunks, originalContent);
      writeFileSync(file_path, newContent, 'utf-8');

      // 6. Summarize
      const { added, removed } = summarizeChanges(parsed.hunks);
      const newLines = newContent.split('\n').length;

      logDebugEvent('patch_file.success', {
        file_path,
        added,
        removed,
        oldLines: originalLines,
        newLines,
      });
      return `Successfully patched ${file_path}\n  ${added} line(s) added, ${removed} line(s) removed\n  ${originalLines} lines → ${newLines} lines`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('patch_file.error', { file_path, error: msg });
      return `Error applying patch to ${file_path}: ${msg}`;
    }
  },
});
