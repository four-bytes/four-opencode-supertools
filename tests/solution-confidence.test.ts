// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { solutionConfidenceTool } from '../src/tools/solution-confidence';

function mockCtx(dir: string) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe('solution_confidence tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-conf-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    ctx = mockCtx(testDir);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  it('returns a score structure with passing tests and reported git error', async () => {
    writeFileSync(
      join(testDir, 'pass.test.ts'),
      `import { describe, it, expect } from 'bun:test';\ndescribe('pass', () => { it('passes', () => { expect(1 + 1).toBe(2); }); });\n`,
      'utf-8'
    );

    const result = await solutionConfidenceTool.execute(
      { description: 'fixed login bug in auth controller' },
      ctx
    );

    expect(result.metadata).toHaveProperty('confidence');
    expect(result.metadata).toHaveProperty('verdict');
    expect(result.metadata).toHaveProperty('risks');
    expect(result.metadata).toHaveProperty('errors');
    expect(result.metadata).toHaveProperty('checks');
    expect(['likely_fixed', 'uncertain', 'band_aid']).toContain(result.metadata.verdict);
    expect(result.metadata.checks.tests).toBe(true);
    expect(result.metadata.checks.coverage).toBe(null);
    expect(result.metadata.errors.length).toBeGreaterThan(0); // temp dir is not a git repo
    expect(result).toHaveProperty('title');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.verdict).toBe('uncertain');
    expect(result.metadata.confidence).toBe(0.5);
  });

  it('returns band_aid when tests fail', async () => {
    writeFileSync(
      join(testDir, 'fail.test.ts'),
      `import { describe, it, expect } from 'bun:test';\ndescribe('fail', () => { it('fails', () => { expect(1).toBe(2); }); });\n`,
      'utf-8'
    );

    const result = await solutionConfidenceTool.execute({ description: 'random change' }, ctx);

    expect(result.metadata.checks.tests).toBe(false);
    expect(result.metadata.verdict).toBe('band_aid');
    expect(result.metadata.errors.length).toBeGreaterThan(0);
  });
});
