import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runTestsTool } from '../src/tools/run-tests';

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

describe('run_tests tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-test-${Date.now()}`);
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

  it('returns error for missing test file', async () => {
    const result = await runTestsTool.execute(
      {
        test_file: join(testDir, 'nonexistent.test.ts'),
      },
      ctx
    );

    expect(result).toContain('Error');
    expect(result).toContain('Test file not found');
  });

  it('runs bun test on a valid test file', async () => {
    const testFilePath = join(testDir, 'simple.test.ts');
    writeFileSync(
      testFilePath,
      `
import { describe, it, expect } from 'bun:test';
describe('simple', () => {
  it('passes', () => {
    expect(1 + 1).toBe(2);
  });
});
`,
      'utf-8'
    );

    const result = await runTestsTool.execute(
      {
        test_file: testFilePath,
        framework: 'bun',
      },
      ctx
    );

    // Should contain pass indication — either JUnit XML or text output
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('handles test filter parameter', async () => {
    const testFilePath = join(testDir, 'filtered.test.ts');
    writeFileSync(
      testFilePath,
      `
import { describe, it, expect } from 'bun:test';
describe('suite', () => {
  it('test one', () => {
    expect(1).toBe(1);
  });
  it('test two', () => {
    expect(2).toBe(2);
  });
});
`,
      'utf-8'
    );

    const result = await runTestsTool.execute(
      {
        test_file: testFilePath,
        filter: 'test one',
        framework: 'bun',
      },
      ctx
    );

    expect(typeof result).toBe('string');
  });
});
