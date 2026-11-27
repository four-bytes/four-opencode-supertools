// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { logDebugEvent } from '../lib/debug-logger';
import { findGoModuleRoot, goPackageTarget } from '../lib/go-module';
import { CARGO_METADATA_ARGS, findCargoRoot, parseCargoWorkspaceRoot } from '../lib/rust-module';
import { findDenoRoot, findTsconfigRoot } from '../lib/ts-module';

export { findGoModuleRoot, findCargoRoot, findDenoRoot, findTsconfigRoot, parseCargoWorkspaceRoot };

type LinterType =
  'eslint' | 'phpstan' | 'pint' | 'ruff' | 'golangci' | 'clippy' | 'tsc' | 'deno' | 'auto';

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function detectLinter(filePath: string): LinterType {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return findDenoRoot(filePath) ? 'deno' : 'eslint';
    case '.php':
      // Prefer phpstan if available, fall back to pint for style
      return 'phpstan';
    case '.py':
      return 'ruff';
    case '.go':
      return 'golangci';
    case '.rs':
      return 'clippy';
    default:
      return 'eslint'; // default
  }
}

export function buildLintCommand(
  linter: LinterType,
  filePath: string,
  moduleRoot?: string
): { cmd: string[]; timeout: number } {
  switch (linter) {
    case 'golangci': {
      // Go lints packages, not files: lint the package directory of the file.
      const target = goPackageTarget(moduleRoot ?? findGoModuleRoot(filePath) ?? '.', filePath);
      return {
        cmd: ['golangci-lint', 'run', '--show-stats=false', target],
        timeout: 120000,
      };
    }
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
    case 'clippy':
      return {
        cmd: ['cargo', 'clippy', '--all-targets', '--message-format=json'],
        timeout: 180000,
      };
    case 'tsc': {
      // tsc checks a whole project: point it at the nearest tsconfig.json directory.
      const root = moduleRoot ?? findTsconfigRoot(filePath) ?? '.';
      return { cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', root], timeout: 180000 };
    }
    case 'deno':
      // deno check runs as a second command from the same root (see execute).
      return { cmd: ['deno', 'lint', '--json', filePath], timeout: 30000 };
    default:
      return { cmd: ['bun', 'x', 'eslint', filePath], timeout: 30000 };
  }
}

// `bun x tsc` resolves a local binary first, then PATH. Mirror that lookup so a
// missing tsc is reported cleanly instead of surfacing raw bun-x output.
export function findTscBinary(
  root: string,
  deps: {
    which: (name: string) => string | null;
    exists: (path: string) => boolean;
  } = { which: (name) => Bun.which(name), exists: (path) => existsSync(path) }
): string | null {
  let dir = resolve(root);
  for (;;) {
    const bin = join(dir, 'node_modules', '.bin', 'tsc');
    if (deps.exists(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return deps.which('tsc');
}

async function runCommand(
  cmd: string[],
  cwd: string,
  timeout: number
): Promise<{ output: string; exitCode: number | null }> {
  try {
    const result = await $`${cmd}`.cwd(cwd).quiet().nothrow();
    return {
      output: result.stdout.toString() + result.stderr.toString(),
      exitCode: result.exitCode,
    };
  } catch {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeout)
    );
    try {
      const output = await Promise.race([new Response(proc.stdout).text(), timeoutPromise]);
      return { output, exitCode: await proc.exited };
    } catch {
      proc.kill();
      return { output: '', exitCode: null };
    }
  }
}

// Diagnostics are shown relative to the working dir when the file lives inside it, else by basename.
function displayPath(absFile: string): string {
  const rel = relative(process.cwd(), absFile).split(sep).join('/');
  if (rel && !rel.startsWith('..')) return rel;
  return basename(absFile);
}

interface ParsedDiagnostics {
  errors: string[];
  warnings: string[];
  errorCount: number;
  warningCount: number;
}

function denoUrlToPath(filename: string): string {
  if (filename.startsWith('file://')) {
    try {
      return fileURLToPath(filename);
    } catch {
      return filename;
    }
  }
  return resolve(filename);
}

// deno check writes ANSI colour codes even when piped; strip them before parsing.
// The ESC char is built at runtime so it never appears as a source-level control char.
const ANSI_ESCAPE = String.fromCharCode(0x1b);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function parseTscOutput(
  output: string,
  targetFile: string,
  tsconfigDir: string
): ParsedDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = resolve(targetFile);
  const root = resolve(tsconfigDir);

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/);
    if (!match) continue;

    const [, rawPath, lineNo, col, level, code, message] = match;
    const absFile = resolve(root, rawPath);
    if (absFile !== target) continue;

    const relPath = relative(root, absFile).split(sep).join('/');
    const formatted = `${relPath}:${lineNo}:${col} ${level}: ${message} [${code}]`;
    if (level === 'error') errors.push(formatted);
    else warnings.push(formatted);
  }

  return { errors, warnings, errorCount: errors.length, warningCount: warnings.length };
}

interface DenoLintDiagnostic {
  filename?: string;
  range?: { start?: { line?: number; col?: number } };
  code?: string;
  message?: string;
}

export function parseDenoLintJson(output: string, targetFile: string): ParsedDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = resolve(targetFile);

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { errors, warnings, errorCount: 0, warningCount: 0 };
  }

  const diagnostics = (parsed as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) {
    return { errors, warnings, errorCount: 0, warningCount: 0 };
  }

  for (const raw of diagnostics) {
    const diagnostic = raw as DenoLintDiagnostic;
    if (typeof diagnostic.filename !== 'string') continue;
    if (resolve(denoUrlToPath(diagnostic.filename)) !== target) continue;

    const line = diagnostic.range?.start?.line ?? 0;
    // deno lint reports a 1-based line but a 0-based column.
    const col = (diagnostic.range?.start?.col ?? 0) + 1;
    const code = diagnostic.code ?? 'deno-lint';
    const message = diagnostic.message ?? '';
    errors.push(`${displayPath(target)}:${line}:${col} error: ${message} [${code}]`);
  }

  return { errors, warnings, errorCount: errors.length, warningCount: warnings.length };
}

export function parseDenoCheckOutput(
  output: string,
  targetFile: string,
  root: string = process.cwd()
): ParsedDiagnostics {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = resolve(targetFile);

  let header: { code: string; level: 'error' | 'warning'; message: string } | null = null;
  for (const rawLine of stripAnsi(output).split('\n')) {
    const line = rawLine.trim();

    const headerMatch = line.match(/^(?:error:\s*)?(TS\d+)\s+\[(ERROR|WARNING)\]:\s*(.*)$/);
    if (headerMatch) {
      header = {
        code: headerMatch[1],
        level: headerMatch[2] === 'ERROR' ? 'error' : 'warning',
        message: headerMatch[3],
      };
      continue;
    }

    if (!header) continue;
    const atMatch = line.match(/^at\s+(.+?):(\d+):(\d+)$/);
    if (!atMatch) continue;

    const rawPath = atMatch[1].startsWith('file://') ? denoUrlToPath(atMatch[1]) : atMatch[1];
    const absFile = resolve(root, rawPath);
    if (absFile === target) {
      const formatted = `${displayPath(target)}:${atMatch[2]}:${atMatch[3]} ${header.level}: ${
        header.message
      } [${header.code}]`;
      if (header.level === 'error') errors.push(formatted);
      else warnings.push(formatted);
    }
    header = null;
  }

  return { errors, warnings, errorCount: errors.length, warningCount: warnings.length };
}

function formatDiagnosticResult(
  filePath: string,
  linter: string,
  parsed: ParsedDiagnostics
): string {
  if (parsed.errorCount === 0 && parsed.warningCount === 0) {
    return `✅ No lint errors in ${filePath}`;
  }
  const lines: string[] = [
    `Lint results for ${filePath} (${linter}):`,
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
  return lines.join('\n');
}

export function parseClippyJson(
  output: string,
  targetFile: string,
  cargoRoot: string,
  workspaceRoot?: string
): {
  errors: string[];
  warnings: string[];
  errorCount: number;
  warningCount: number;
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const target = resolve(targetFile);
  // Clippy paths are relative to the Cargo workspace root when the crate is a member.
  const pathRoot = resolve(workspaceRoot ?? cargoRoot);

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const entry = parsed as {
      reason?: string;
      message?: {
        level?: string;
        message?: string;
        code?: { code?: string } | null;
        spans?: Array<{
          file_name?: string;
          line_start?: number;
          column_start?: number;
        }>;
      };
    };
    if (entry.reason !== 'compiler-message' || !entry.message) continue;

    const level = entry.message.level;
    if (level !== 'error' && level !== 'warning') continue;

    const spans = entry.message.spans ?? [];
    const span = spans.find((s) => {
      if (typeof s.file_name !== 'string') return false;
      return resolve(pathRoot, s.file_name) === target;
    });
    if (!span) continue;

    const absSpan = resolve(pathRoot, span.file_name as string);
    const relPath = relative(pathRoot, absSpan).split(sep).join('/');
    const code = entry.message.code?.code;
    const formatted = `${relPath}:${span.line_start ?? 0}:${span.column_start ?? 0} ${level}: ${
      entry.message.message ?? ''
    }${code ? ` [${code}]` : ''}`;

    if (level === 'error') {
      errors.push(formatted);
    } else {
      warnings.push(formatted);
    }
  }

  return {
    errors,
    warnings,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
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
- .ts/.tsx/.js/.jsx/.mjs/.cjs → Deno lint + deno check in a Deno project, else ESLint (add typecheck: true for tsc --noEmit)
- .php → PHPStan (or pint with linter: "pint")
- .py → Ruff
- .go → golangci-lint (lints the file's package, run from the nearest go.mod)
- .rs → cargo clippy --all-targets (crate incl. tests/benches/examples; diagnostics filtered to the exact file, paths normalised against the Cargo workspace root)

Returns structured output: error count, warning count, and formatted error list.`,

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file to lint'),
    directory: tool.schema
      .string()
      .optional()
      .describe(
        'Working directory for the linter (defaults to the project directory). Use to lint a foreign repo.'
      ),
    linter: tool.schema
      .string()
      .optional()
      .describe(
        'Override auto-detection: "eslint", "phpstan", "pint", "ruff", "golangci", "clippy", "tsc", "deno", or "auto" (default)'
      ),
    typecheck: tool.schema
      .boolean()
      .optional()
      .describe(
        'Run tsc --noEmit for TS/JS files in addition to the linter; ignored for Deno projects'
      ),
  },

  async execute(args, ctx) {
    const { file_path, linter: linterArg, typecheck } = args;
    const directory = (args.directory as string | undefined) ?? ctx.directory;

    logDebugEvent('lint_file.start', { file_path, linter: linterArg });

    try {
      // 1. Validate file exists
      if (!existsSync(file_path)) {
        return `Error: File not found: ${file_path}`;
      }

      // 2. Determine linter
      const linter: LinterType = (linterArg as LinterType) || detectLinter(file_path);
      const absFile = resolve(directory, file_path);
      const isTsJs = TS_JS_EXTENSIONS.has(extname(file_path).toLowerCase());

      // Deno project (auto or explicit): deno lint + deno check, merged.
      if (linter === 'deno') {
        const denoRoot = findDenoRoot(absFile);
        if (!denoRoot) {
          return `Error: No deno.json/deno.jsonc found above ${file_path}`;
        }
        if (!Bun.which('deno')) {
          return '⚠️ deno not found. Install Deno: https://deno.land/#installation';
        }
        const lint = await runCommand(['deno', 'lint', '--json', absFile], denoRoot, 30000);
        const check = await runCommand(['deno', 'check', absFile], denoRoot, 180000);
        const lintParsed = parseDenoLintJson(lint.output, absFile);
        const checkParsed = parseDenoCheckOutput(check.output, absFile, denoRoot);
        const merged: ParsedDiagnostics = {
          errors: [...lintParsed.errors, ...checkParsed.errors],
          warnings: [...lintParsed.warnings, ...checkParsed.warnings],
          errorCount: lintParsed.errorCount + checkParsed.errorCount,
          warningCount: lintParsed.warningCount + checkParsed.warningCount,
        };
        if (merged.errorCount === 0 && merged.warningCount === 0) {
          if (lint.exitCode === 0 && check.exitCode === 0) {
            return `✅ No lint errors in ${file_path}`;
          }
          const tail = `${lint.output}\n${check.output}`.trim().split('\n').slice(-20).join('\n');
          return `Error: deno lint/check failed (exit ${check.exitCode ?? lint.exitCode}) for ${file_path}:\n${tail}`;
        }
        logDebugEvent('lint_file.complete', { file_path, exitCode: check.exitCode });
        return formatDiagnosticResult(file_path, 'deno', merged);
      }

      // Explicit tsc: only the type-check run.
      if (linter === 'tsc') {
        const tsconfigRoot = findTsconfigRoot(absFile);
        if (!tsconfigRoot) {
          return 'tsc: no tsconfig.json found — type-check skipped';
        }
        if (!findTscBinary(tsconfigRoot)) {
          return '⚠️ tsc not available (bun x tsc)';
        }
        const { cmd, timeout } = buildLintCommand('tsc', absFile, tsconfigRoot);
        const check = await runCommand(cmd, tsconfigRoot, timeout);
        const parsed = parseTscOutput(check.output, absFile, tsconfigRoot);
        if (parsed.errorCount === 0 && parsed.warningCount === 0) {
          if (check.exitCode === 0) {
            return `✅ No lint errors in ${file_path}`;
          }
          const tail = check.output.trim().split('\n').slice(-20).join('\n');
          return `Error: tsc failed (exit ${check.exitCode}) for ${file_path}:\n${tail}`;
        }
        logDebugEvent('lint_file.complete', { file_path, exitCode: check.exitCode });
        return formatDiagnosticResult(file_path, 'tsc', parsed);
      }

      // 3. Build and run command
      let cwd = directory;
      let cargoRoot: string | null = null;
      let cargoWorkspaceRoot: string | null = null;
      if (linter === 'golangci') {
        const moduleRoot = findGoModuleRoot(resolve(directory, file_path));
        if (!moduleRoot) {
          return `Error: No go.mod found above ${file_path}`;
        }
        cwd = moduleRoot;
      } else if (linter === 'clippy') {
        cargoRoot = findCargoRoot(resolve(directory, file_path));
        if (!cargoRoot) {
          return `Error: No Cargo.toml found above ${file_path}`;
        }
        cwd = cargoRoot;
        if (!Bun.which('cargo')) {
          return '⚠️ cargo not found. Install the Rust toolchain: https://rustup.rs (and run: rustup component add clippy)';
        }
        // Diagnostic paths are relative to the workspace root, which can sit above the
        // nearest (member) Cargo.toml. Fall back to the crate root if metadata fails.
        try {
          const metadata = await $`${CARGO_METADATA_ARGS}`.cwd(cargoRoot).quiet().nothrow();
          if (metadata.exitCode === 0) {
            cargoWorkspaceRoot = parseCargoWorkspaceRoot(metadata.stdout.toString());
          }
        } catch {
          cargoWorkspaceRoot = null;
        }
      }
      const { cmd, timeout } = buildLintCommand(linter, file_path, cwd);

      logDebugEvent('lint_file.command', { cmd: cmd.join(' '), linter });

      let output: string;
      let exitCode: number | null;

      try {
        const result = await $`${cmd}`.cwd(cwd).quiet().nothrow();
        output = result.stdout.toString() + result.stderr.toString();
        exitCode = result.exitCode;
      } catch {
        // Fall back to Bun.spawn if bun shell fails
        const proc = Bun.spawn(cmd, {
          cwd,
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
      if (linter === 'clippy') {
        const root = cargoRoot ?? cwd;
        const parsed = parseClippyJson(
          output,
          resolve(directory, file_path),
          root,
          cargoWorkspaceRoot ?? undefined
        );
        if (parsed.errorCount === 0 && parsed.warningCount === 0) {
          if (exitCode === 0) {
            result = `✅ No lint errors in ${file_path}`;
          } else {
            const tail = output.trim().split('\n').slice(-30).join('\n');
            result = `Error: cargo clippy failed (exit ${exitCode}) for ${file_path}:\n${tail}`;
          }
        } else {
          const lines: string[] = [
            `Lint results for ${file_path} (clippy):`,
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
      } else if (linter === 'eslint') {
        const parsed = parseEslintOutput(output);
        const notes: string[] = [];
        if (typecheck && isTsJs && !findDenoRoot(absFile)) {
          const tsconfigRoot = findTsconfigRoot(absFile);
          if (!tsconfigRoot) {
            notes.push('tsc: no tsconfig.json found — type-check skipped');
          } else {
            const tsc = buildLintCommand('tsc', absFile, tsconfigRoot);
            const check = await runCommand(tsc.cmd, tsconfigRoot, tsc.timeout);
            const tscParsed = parseTscOutput(check.output, absFile, tsconfigRoot);
            parsed.errors.push(...tscParsed.errors);
            parsed.warnings.push(...tscParsed.warnings);
            parsed.errorCount += tscParsed.errorCount;
            parsed.warningCount += tscParsed.warningCount;
          }
        }
        if (parsed.errorCount === 0 && parsed.warningCount === 0) {
          result = [`✅ No lint errors in ${file_path}`, ...notes].join('\n');
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
          lines.push(...notes);
          result = lines.join('\n');
        }
      } else if (linter === 'golangci' && exitCode !== 0 && exitCode !== 1) {
        // golangci-lint: 1 = issues found; anything else is a config, load or run failure
        result = `Error: golangci-lint failed (exit ${exitCode}) for ${file_path}:\n${output.trim()}`;
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
