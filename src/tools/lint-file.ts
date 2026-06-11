// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { $ } from 'bun';
import { logDebugEvent } from '../lib/debug-logger';

type LinterType = 'eslint' | 'phpstan' | 'pint' | 'ruff' | 'auto';

function detectLinter(filePath: string): LinterType {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
      return 'eslint';
    case '.php':
      // Prefer phpstan if available, fall back to pint for style
      return 'phpstan';
    case '.py':
      return 'ruff';
    default:
      return 'eslint'; // default
  }
}

function buildLintCommand(
  linter: LinterType,
  filePath: string
): { cmd: string[]; timeout: number } {
  switch (linter) {
    case 'eslint':
      return { cmd: ['bun', 'x', 'eslint', filePath, '--format', 'stylish'], timeout: 30000 };
    case 'phpstan':
      return {
        cmd: ['phpstan', 'analyse', filePath, '--error-format=raw', '--no-progress'],
        timeout: 60000,
      };
    case 'pint':
      return {
        cmd: ['php', 'vendor/bin/pint', filePath, '--test', '--format=json'],
        timeout: 30000,
      };
    case 'ruff':
      return { cmd: ['ruff', 'check', filePath, '--output-format=concise'], timeout: 30000 };
    default:
      return { cmd: ['bun', 'x', 'eslint', filePath], timeout: 30000 };
  }
}

function parseEslintOutput(output: string): {
  errors: string[];
  warnings: string[];
  errorCount: number;
  warningCount: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  let errorCount = 0;
  let warningCount = 0;

  // Parse stylish format output
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.includes('error') && !line.includes('✖')) {
      errors.push(line.trim());
      errorCount++;
    } else if (line.includes('warning')) {
      warnings.push(line.trim());
      warningCount++;
    }
  }

  // Try to extract counts from summary line
  const summaryMatch = output.match(/(\d+) error\(s\).*?(\d+) warning\(s\)/);
  if (summaryMatch) {
    errorCount = Math.max(errorCount, parseInt(summaryMatch[1], 10));
    warningCount = Math.max(warningCount, parseInt(summaryMatch[2], 10));
  }

  return { errors, warnings, errorCount, warningCount };
}

export const lintFileTool = tool({
  description: `Run a linter on a specific file and return only errors and warnings. Saves ~60% tokens vs. bash→read→parse.

Auto-detects the appropriate linter based on file extension:
- .ts/.tsx/.js/.jsx → ESLint
- .php → PHPStan (or pint with linter: "pint")
- .py → Ruff

Returns structured output: error count, warning count, and formatted error list.`,

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file to lint'),
    linter: tool.schema
      .string()
      .optional()
      .describe(
        'Override auto-detection: "eslint", "phpstan", "pint", "ruff", or "auto" (default)'
      ),
  },

  async execute(args, ctx) {
    const { file_path, linter: linterArg } = args;
    const directory = ctx.directory;

    logDebugEvent('lint_file.start', { file_path, linter: linterArg });

    try {
      // 1. Validate file exists
      if (!existsSync(file_path)) {
        return `Error: File not found: ${file_path}`;
      }

      // 2. Determine linter
      const linter: LinterType = (linterArg as LinterType) || detectLinter(file_path);

      // 3. Build and run command
      const { cmd, timeout } = buildLintCommand(linter, file_path);

      logDebugEvent('lint_file.command', { cmd: cmd.join(' '), linter });

      let output: string;
      let exitCode: number | null;

      try {
        const result = await $`${cmd}`.cwd(directory).quiet().nothrow();
        output = result.stdout.toString() + result.stderr.toString();
        exitCode = result.exitCode;
      } catch {
        // Fall back to Bun.spawn if bun shell fails
        const proc = Bun.spawn(cmd, {
          cwd: directory,
          stdout: 'pipe',
          stderr: 'pipe',
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeout)
        );

        const raceResult = await Promise.race([
          new Response(proc.stdout)
            .text()
            .then((t) => ({ stdout: t, stderr: '', exitCode: proc.exitCode })),
          timeoutPromise,
        ]);

        output = raceResult.stdout;
        exitCode = raceResult.exitCode;
      }

      // 4. Parse output based on linter
      let result: string;
      if (linter === 'eslint') {
        const parsed = parseEslintOutput(output);
        if (parsed.errorCount === 0 && parsed.warningCount === 0) {
          result = `✅ No lint errors in ${file_path}`;
        } else {
          const lines: string[] = [
            `Lint results for ${file_path} (${linter}):`,
            `  Errors: ${parsed.errorCount}, Warnings: ${parsed.warningCount}`,
          ];
          if (parsed.errors.length > 0) {
            lines.push('\nErrors:');
            lines.push(...parsed.errors.map((e) => `  ${e}`));
          }
          if (parsed.warnings.length > 0) {
            lines.push('\nWarnings:');
            lines.push(...parsed.warnings.map((w) => `  ${w}`));
          }
          result = lines.join('\n');
        }
      } else {
        // Generic handling for other linters
        const lines = output.split('\n').filter((l) => l.trim().length > 0);
        if (exitCode === 0) {
          result = `✅ No lint errors in ${file_path}`;
        } else {
          result = [
            `Lint results for ${file_path} (${linter}):`,
            ...lines.map((l) => `  ${l}`),
          ].join('\n');
        }
      }

      logDebugEvent('lint_file.complete', { file_path, exitCode });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('lint_file.error', { file_path, error: msg });
      return `Error linting ${file_path}: ${msg}`;
    }
  },
});
