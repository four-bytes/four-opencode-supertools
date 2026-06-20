// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { solutionConfidenceTool } from '../src/tools/solution-confidence';

describe('solution_confidence tool', () => {
  it('returns score structure with all checks passing', async () => {
    const ctx = {
      sessionID: 'test-session',
      messageID: 'test-message',
      agent: 'test-agent',
      directory: '/tmp',
      worktree: '/tmp',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'run_tests') return { pass: 5, fail: 0, failures: 0 };
        if (name === 'brain_search') return [{ score: 0.8, content: 'match' }];
        if (name === 'pr_risk') return { risk_level: 'low' };
        return [];
      },
    };

    const result = await solutionConfidenceTool.execute(
      { description: 'fixed login bug in auth controller' },
      ctx as any
    );

    expect(result.metadata).toHaveProperty('confidence');
    expect(result.metadata).toHaveProperty('verdict');
    expect(result.metadata).toHaveProperty('risks');
    expect(result.metadata).toHaveProperty('checks');
    expect(['likely_fixed', 'uncertain', 'band_aid']).toContain(result.metadata.verdict);
  });

  it('returns band_aid when all checks fail', async () => {
    const ctx = {
      callTool: async (_name: string, _args: Record<string, unknown>) => {
        throw new Error('all fail');
      },
    } as any;

    const result = await solutionConfidenceTool.execute(
      { description: 'random change' },
      ctx
    );

    expect(result.metadata.verdict).toBe('band_aid');
    expect(result.metadata.confidence).toBe(0);
  });
});
