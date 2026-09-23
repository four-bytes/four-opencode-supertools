// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { detectFramework, type TestFramework } from './run-tests';

function fullSuiteCommand(framework: TestFramework): string[] {
  switch (framework) {
    case 'phpunit':
      return ['php', 'vendor/bin/phpunit', '--no-coverage'];
    case 'vitest':
      return ['bun', 'x', 'vitest', 'run'];
    case 'jest':
      return ['bun', 'x', 'jest'];
    case 'bun':
    case 'auto':
    default:
      return ['bun', 'test'];
  }
}

interface CommandResult {
  exitCode: number;
  output: string;
}

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(
        new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s: ${cmd.join(' ')}`)
      );
    }, timeoutMs)
  );

  const collect = async (): Promise<CommandResult> => {
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    return { exitCode, output: `${stdout}\n${stderr}` };
  };

  return Promise.race([collect(), timeout]);
}

export const solutionConfidenceTool = tool({
  description: `Score how likely a fix actually resolved the problem. Runs the project test suite and inspects uncommitted changes via git directly. Reports errors instead of hiding them.`,

  args: {
    description: tool.schema
      .string()
      .describe('Description of the fix — used for logging and context'),
    evidence: tool.schema
      .string()
      .optional()
      .describe('Optional JSON array of evidence strings (e.g., test file paths, KB entry keys)'),
  },

  async execute(args, ctx) {
    const directory = ctx.directory;
    logDebugEvent('solution_confidence.start', { description: args.description.substring(0, 60) });

    const errors: string[] = [];
    const risks: string[] = [];
    let testsPassed: boolean | null = null;
    let coverageChecked: boolean | null;

    // 1. Run the test suite directly (captured output + timeout + kill)
    try {
      const framework = detectFramework(directory);
      const { exitCode } = await runWithTimeout(fullSuiteCommand(framework), directory, 120000);
      testsPassed = exitCode === 0;
      if (!testsPassed) {
        risks.push(`Test suite exited with code ${exitCode}`);
      }
    } catch (err) {
      errors.push(`tests: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Inspect uncommitted changes directly via git (blast radius)
    try {
      const status = await runWithTimeout(
        ['git', '-C', directory, 'status', '--porcelain'],
        directory,
        15000
      );
      if (status.exitCode !== 0) {
        throw new Error(`git status exited ${status.exitCode}`);
      }
      coverageChecked = true;
      const changed = status.output
        .trim()
        .split('\n')
        .filter((l) => l.trim());
      const sourceChanged = changed.filter((l) => {
        const path = l.slice(3).trim();
        return path !== '' && !/\.(test|spec)\.[a-z0-9]+$/i.test(path);
      });
      if (sourceChanged.length > 0) {
        const diff = await runWithTimeout(
          ['git', '-C', directory, 'diff', '--stat', 'HEAD'],
          directory,
          15000
        );
        const statLines = diff.output
          .trim()
          .split('\n')
          .filter((l) => l.trim());
        const lastLine = statLines.pop() ?? '';
        const fileCountMatch = lastLine.match(/(\d+) files? changed/);
        const fileCount = fileCountMatch ? parseInt(fileCountMatch[1], 10) : sourceChanged.length;
        risks.push(
          `Uncommitted changes in ${sourceChanged.length} source file(s) — verify tests cover them`
        );
        if (fileCount >= 10) {
          risks.push('High blast radius — uncommitted changes touch many files');
        }
      }
    } catch (err) {
      coverageChecked = null;
      errors.push(`coverage: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Weighted scoring (tests 0.5 + coverage 0.5). No redistribution: an errored
    // check must not inflate confidence.
    let score = 0;
    if (testsPassed === true) score += 0.5;
    if (coverageChecked === true) score += 0.5;

    let verdict: 'likely_fixed' | 'uncertain' | 'band_aid';
    if (score >= 0.75) verdict = 'likely_fixed';
    else if (score >= 0.45) verdict = 'uncertain';
    else verdict = 'band_aid';

    logDebugEvent('solution_confidence.complete', { score, verdict, errorCount: errors.length });

    const result = {
      confidence: Math.round(score * 100) / 100,
      verdict,
      risks,
      errors,
      checks: { tests: testsPassed, coverage: coverageChecked },
    };
    return {
      title: `Confidence: ${result.verdict} (${result.confidence})`,
      output: JSON.stringify(result, null, 2),
      metadata: result,
    };
  },
});
