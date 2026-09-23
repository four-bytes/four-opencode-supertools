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

    // 1. Run the test suite directly
    try {
      const framework = detectFramework(directory);
      const cmd = fullSuiteCommand(framework);
      const proc = await Bun.$`${cmd}`.cwd(directory).nothrow();
      testsPassed = proc.exitCode === 0;
      if (!testsPassed) {
        risks.push(`Test suite exited with code ${proc.exitCode}`);
      }
    } catch (err) {
      errors.push(`tests: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. Inspect uncommitted changes directly via git (blast radius)
    try {
      const status = await Bun.$`git -C ${directory} status --porcelain`.nothrow();
      if (status.exitCode !== 0) {
        throw new Error(`git status exited ${status.exitCode}`);
      }
      coverageChecked = true;
      const changed = status.stdout
        .toString()
        .trim()
        .split('\n')
        .filter((l) => l.trim());
      const sourceChanged = changed.filter((l) => {
        const path = l.slice(3).trim();
        return path !== '' && !/\.(test|spec)\.[a-z0-9]+$/i.test(path);
      });
      if (sourceChanged.length > 0) {
        const diff = await Bun.$`git -C ${directory} diff --stat HEAD`.nothrow();
        const statLines = diff.stdout
          .toString()
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

    // Weighted scoring (tests 0.5 + coverage 0.5)
    const weights = { tests: 0.5, coverage: 0.5 };
    let score = 0;
    if (testsPassed === true) score += weights.tests;
    if (coverageChecked === true) score += weights.coverage;

    const activeChecks = [testsPassed !== null, coverageChecked !== null].filter(Boolean).length;
    if (activeChecks > 0) {
      score = score * (2 / activeChecks);
      score = Math.min(score, 1.0);
    }

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
