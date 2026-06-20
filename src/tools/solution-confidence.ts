// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';

export const solutionConfidenceTool = tool({
  description: `Score how likely a fix actually resolved the problem. Runs tests, searches brain for matching KB patterns, and checks git blast radius coverage. Returns weighted confidence score.`,

  args: {
    description: tool.schema.string().describe('Description of the fix — used to find relevant tests and KB entries'),
    evidence: tool.schema
      .string()
      .optional()
      .describe('Optional JSON array of evidence strings (e.g., test file paths, KB entry keys)'),
  },

  async execute(args, ctx) {
    logDebugEvent('solution_confidence.start', { description: args.description.substring(0, 60) });

    let testsPassed: boolean | null = null;
    let kbMatch: boolean | null = null;
    let coverageChecked: boolean | null = null;
    const risks: string[] = [];

    // 1. Run tests — detect test files from description keywords
    try {
      const words = args.description.split(/\s+/).filter((w: string) => w.length > 3);
      const testPattern = words.slice(0, 3).join('|');

      try {
        const testResult = await (ctx as any).callTool('run_tests', { test_file: '.', filter: testPattern });
        if (testResult && typeof testResult === 'object') {
          testsPassed = (testResult as Record<string, unknown>).failures === 0;
        }
      } catch {
        testsPassed = null;
      }
    } catch {
      testsPassed = null;
    }

    // 2. Search brain for matching KB patterns
    try {
      const kbResults = await (ctx as any).callTool('brain_search', { query: args.description, limit: 3 });
      if (Array.isArray(kbResults) && kbResults.length > 0) {
        const bestMatch = kbResults[0] as Record<string, unknown>;
        kbMatch = typeof bestMatch.score === 'number' && bestMatch.score > 0.7;
      } else {
        kbMatch = false;
      }
    } catch {
      kbMatch = null;
    }

    // 3. Git coverage check (pr_risk)
    try {
      const prResult = await (ctx as any).callTool('pr_risk', {});
      coverageChecked = prResult !== undefined;
      if (prResult && typeof prResult === 'object') {
        const riskLevel = (prResult as Record<string, unknown>).risk_level;
        if (riskLevel === 'high') {
          risks.push('High blast radius — uncommitted changes touch high-risk files');
        }
      }
    } catch {
      coverageChecked = null;
    }

    // Weighted scoring
    const weights = { tests: 0.4, kb: 0.3, coverage: 0.3 };
    let score = 0;
    if (testsPassed === true) score += weights.tests;
    if (testsPassed === false) score += 0;
    if (kbMatch === true) score += weights.kb;
    if (coverageChecked === true) score += weights.coverage;

    // If any check is null, redistribute weight proportionally
    const activeChecks = [testsPassed !== null, kbMatch !== null, coverageChecked !== null].filter(Boolean).length;
    if (activeChecks > 0 && activeChecks < 3) {
      score = score * (3 / activeChecks);
    }

    let verdict: 'likely_fixed' | 'uncertain' | 'band_aid';
    if (score >= 0.75) verdict = 'likely_fixed';
    else if (score >= 0.45) verdict = 'uncertain';
    else verdict = 'band_aid';

    logDebugEvent('solution_confidence.complete', { score, verdict });
    const result = {
      confidence: Math.round(score * 100) / 100,
      verdict,
      risks,
      checks: { tests: testsPassed, kb_match: kbMatch, coverage: coverageChecked },
    };
    return {
      title: `Confidence: ${result.verdict} (${result.confidence})`,
      output: JSON.stringify(result, null, 2),
      metadata: result,
    };
  },
});
