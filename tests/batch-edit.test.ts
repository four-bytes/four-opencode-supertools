import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchEditTool } from '../src/tools/batch-edit';

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

describe('batch_edit tool', () => {
  let testDir: string;
  let ctx: ReturnType<typeof mockCtx>;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-batchedit-${Date.now()}`);
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

  it('replaces text across multiple files', async () => {
    writeFileSync(join(testDir, 'a.ts'), 'const foo = 1;\nconst bar = foo;\n', 'utf-8');
    writeFileSync(join(testDir, 'b.ts'), 'const foo = 2;\n', 'utf-8');

    const result = await batchEditTool.execute(
      {
        search: 'foo',
        replace: 'baz',
        glob: '*.ts',
        path: '.',
      },
      ctx
    );

    expect(result).toContain('3 match(es) across 2 file(s)');
    expect(readFileSync(join(testDir, 'a.ts'), 'utf-8')).toBe('const baz = 1;\nconst bar = baz;\n');
    expect(readFileSync(join(testDir, 'b.ts'), 'utf-8')).toBe('const baz = 2;\n');
  });

  it('dry run does not modify files', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'const foo = 1;\n', 'utf-8');

    const result = await batchEditTool.execute(
      {
        search: 'foo',
        replace: 'bar',
        glob: '*.ts',
        dry_run: true,
      },
      ctx
    );

    expect(result).toContain('[DRY RUN]');
    expect(result).toContain('Dry run');
    expect(readFileSync(join(testDir, 'test.ts'), 'utf-8')).toBe('const foo = 1;\n');
  });

  it('handles regex with capture groups', async () => {
    writeFileSync(join(testDir, 'test.ts'), 'const x = oldName;\n', 'utf-8');

    const result = await batchEditTool.execute(
      {
        search: 'old(\\w+)',
        replace: 'new$1',
        glob: '*.ts',
      },
      ctx
    );

    expect(readFileSync(join(testDir, 'test.ts'), 'utf-8')).toBe('const x = newName;\n');
  });

  it('returns error for invalid regex', async () => {
    const result = await batchEditTool.execute(
      {
        search: '[unclosed',
        replace: 'x',
        glob: '*.ts',
      },
      ctx
    );

    expect(result).toContain('Error');
    expect(result).toContain('Invalid regex');
  });
});
