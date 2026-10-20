// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { logDebugEvent } from '../lib/debug-logger';

export type TestFramework = 'bun' | 'phpunit' | 'jest' | 'vitest' | 'go' | 'auto';

export function detectFramework(directory: string): TestFramework {
  // Check for PHP project
  if (existsSync(resolve(directory, 'composer.json'))) {
    return 'phpunit';
  }
  // Check for Go module
  if (existsSync(resolve(directory, 'go.mod'))) {
    return 'go';
  }
  // Check for Bun project
  if (
    existsSync(resolve(directory, 'bunfig.toml')) ||
    existsSync(resolve(directory, 'bun.lockb'))
  ) {
    return 'bun';
  }
  // Check for package.json → jest/vitest
  if (existsSync(resolve(directory, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf-8'));
      if (pkg.devDependencies?.vitest || pkg.dependencies?.vitest) return 'vitest';
      if (pkg.devDependencies?.jest || pkg.dependencies?.jest) return 'jest';
    } catch {
      /* ignore parse errors */
    }
    return 'bun'; // default for JS/TS projects
  }
  return 'bun';
}

export function buildTestCommand(
  framework: TestFramework,
  testFile: string,
  filter?: string,
  directory?: string
): { cmd: string[]; timeout: number } {
  switch (framework) {
    case 'go': {
      // go test runs packages: test the package directory of the given _test.go file.
      const pkgDir = directory ? relative(directory, dirname(testFile)) : dirname(testFile);
      const target = pkgDir === '' ? '.' : pkgDir.startsWith('.') ? pkgDir : `./${pkgDir}`;
      const cmd = ['go', 'test', '-count=1', target];
      if (filter) cmd.push('-run', filter);
      return { cmd, timeout: 300000 };
    }
    case 'bun':
      if (filter) {
        return { cmd: ['bun', 'test', '--filter', filter, '--reporter', 'junit'], timeout: 120000 };
      }
      return { cmd: ['bun', 'test', testFile, '--reporter', 'junit'], timeout: 120000 };
    case 'vitest':
      if (filter) {
        return {
          cmd: ['bun', 'x', 'vitest', 'run', testFile, '-t', filter, '--reporter=verbose'],
          timeout: 120000,
        };
      }
      return {
        cmd: ['bun', 'x', 'vitest', 'run', testFile, '--reporter=verbose'],
        timeout: 120000,
      };
    case 'jest':
      if (filter) {
        return { cmd: ['bun', 'x', 'jest', testFile, '-t', filter, '--verbose'], timeout: 120000 };
      }
      return { cmd: ['bun', 'x', 'jest', testFile, '--verbose'], timeout: 120000 };
    case 'phpunit':
      if (filter) {
        return {
          cmd: ['php', 'vendor/bin/phpunit', testFile, '--filter', filter, '--no-coverage'],
          timeout: 120000,
        };
      }
      return { cmd: ['php', 'vendor/bin/phpunit', testFile, '--no-coverage'], timeout: 120000 };
    default:
      return { cmd: ['bun', 'test', testFile], timeout: 120000 };
  }
}

// go test plain output: "ok" / "FAIL" package lines, "--- FAIL:" per test, indented details.
export function parseGoTestOutput(output: string, exitCode: number | null): string {
  const lines = output.split('\n').filter((l) => l.trim());
  if (exitCode === 0) {
    const okLines = lines.filter((l) => l.startsWith('ok') || l.includes('[no test files]'));
    return `✅ ${okLines.join('\n') || 'All tests passed'}`;
  }

  const relevant: string[] = [];
  let inFailure = false;
  for (const line of lines) {
    if (line.startsWith('--- FAIL') || line.startsWith('FAIL') || line.startsWith('panic:')) {
      relevant.push(line);
      inFailure = line.startsWith('--- FAIL') || line.startsWith('panic:');
    } else if (line.startsWith('# ') || /^\S+\.go:\d+:\d+: /.test(line)) {
      // build errors: package header and file:line:col messages
      relevant.push(line);
    } else if (inFailure && /^\s/.test(line)) {
      relevant.push(line);
    } else {
      inFailure = false;
    }
  }

  if (relevant.length === 0) {
    return `Test run failed (exit ${exitCode}):\n${lines.slice(-20).join('\n')}`;
  }
  return `Test results: FAILED\n\n${relevant.join('\n')}`;
}

function parseTestOutput(output: string): string {
  // Try to parse as JUnit XML (bun test --reporter=junit)
  if (output.includes('<testsuites')) {
    const testsMatch = output.match(/tests="(\d+)"/);
    const failuresMatch = output.match(/failures="(\d+)"/);
    const errorsMatch = output.match(/errors="(\d+)"/);
    const timeMatch = output.match(/time="([\d.]+)"/);

    const tests = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const failures = failuresMatch ? parseInt(failuresMatch[1], 10) : 0;
    const errors = errorsMatch ? parseInt(errorsMatch[1], 10) : 0;
    const time = timeMatch ? timeMatch[1] : '?';

    // Extract failure details from <failure> tags
    const failureBlocks = output.match(/<failure[^>]*>([\s\S]*?)<\/failure>/g) || [];
    const failureDetails: string[] = [];
    for (const block of failureBlocks) {
      const content = block.replace(/<\/?failure[^>]*>/g, '').trim();
      if (content) {
        // Extract the first meaningful lines from each failure
        const contentLines = content.split('\n').filter((l) => l.trim());
        failureDetails.push(contentLines.slice(0, 5).join('\n'));
      }
    }

    if (failures === 0 && errors === 0) {
      return `✅ All ${tests} test(s) passed in ${time}s`;
    }

    const resultLines: string[] = [
      `Test results: ${tests} total, ${failures} failed, ${errors} errors (${time}s)`,
    ];

    if (failureDetails.length > 0) {
      resultLines.push('\nFailures:');
      failureDetails.forEach((detail, i) => {
        resultLines.push(`\n  Failure ${i + 1}:`);
        resultLines.push(...detail.split('\n').map((l) => `    ${l}`));
      });
    }

    return resultLines.join('\n');
  }

  // PHPUnit plain output
  if (output.includes('PHPUnit')) {
    const outputLines = output.split('\n').filter((l) => l.trim());
    const summary = outputLines.find(
      (l) => l.includes('Tests:') || l.includes('OK') || l.includes('FAILURES')
    );
    const failures = outputLines.filter((l) => l.includes('FAIL') || l.includes('Error:'));

    if (!failures.length) {
      const okLine = summary || 'All tests passed';
      return `✅ ${okLine.trim()}`;
    }

    return [
      summary?.trim() || 'Test results:',
      '',
      'Failures:',
      ...failures.map((f) => `  ${f.trim()}`),
    ].join('\n');
  }

  // Fallback: return last 50 lines (most relevant output)
  const allLines = output.split('\n');
  const relevant = allLines.slice(-50);

  // Try to find test summary
  const summaryLine = relevant.find(
    (l) =>
      l.includes('pass') ||
      l.includes('fail') ||
      l.includes('tests') ||
      l.includes('OK') ||
      l.includes('FAIL')
  );

  if (summaryLine) {
    return `${summaryLine}\n\n${relevant.slice(-20).join('\n')}`;
  }

  return relevant.join('\n');
}

export const runTestsTool = tool({
  description: `Run tests for a specific file and return only failures. Saves ~50% tokens vs. bash→read→parse.

Auto-detects the test framework from project configuration:
- bun test (Bun projects)
- phpunit (PHP/composer projects)
- vitest / jest (package.json detection)
- go test (go.mod; runs the package of the given _test.go file)

Returns structured output: pass/fail counts, failure details, execution time.`,

  args: {
    test_file: tool.schema.string().describe('Absolute path to the test file to run'),
    filter: tool.schema
      .string()
      .optional()
      .describe('Optional test name pattern to filter (e.g., "should handle errors")'),
    framework: tool.schema
      .string()
      .optional()
      .describe(
        'Override auto-detection: "bun", "phpunit", "jest", "vitest", "go", or "auto" (default)'
      ),
  },

  async execute(args, ctx) {
    const { test_file, filter, framework: frameworkArg } = args;
    const directory = ctx.directory;

    logDebugEvent('run_tests.start', { test_file, filter, framework: frameworkArg });

    try {
      // 1. Validate file exists
      if (!existsSync(test_file)) {
        return `Error: Test file not found: ${test_file}`;
      }

      // 2. Determine framework
      const framework: TestFramework =
        (frameworkArg as TestFramework) || detectFramework(directory);

      // 3. Build and run command
      const { cmd, timeout } = buildTestCommand(framework, test_file, filter, directory);

      logDebugEvent('run_tests.command', { cmd: cmd.join(' '), framework });

      // 4. Run tests with timeout
      const proc = Bun.spawn(cmd, {
        cwd: directory,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Test execution timed out after ${timeout / 1000}s`));
        }, timeout)
      );

      let output: string;
      try {
        const result = await Promise.race([
          (async () => {
            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            return stdout + '\n' + stderr;
          })(),
          timeoutPromise,
        ]);
        output = result;
      } catch (err) {
        if (err instanceof Error && err.message.includes('timed out')) {
          return `Error: Test execution timed out after ${timeout / 1000}s for ${test_file}`;
        }
        throw err;
      }

      // 5. Parse and format output
      const result =
        framework === 'go' ? parseGoTestOutput(output, await proc.exited) : parseTestOutput(output);

      logDebugEvent('run_tests.complete', {
        test_file,
        framework,
        outputLength: output.length,
        resultLength: result.length,
        savings: output.length > 0 ? Math.round((1 - result.length / output.length) * 100) : 0,
      });

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('run_tests.error', { test_file, error: msg });
      return `Error running tests for ${test_file}: ${msg}`;
    }
  },
});
