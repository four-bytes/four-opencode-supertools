import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test the tool's execute function directly
// (We import the raw execute function by accessing it from the tool definition)
import { applyPatchTool } from '../src/tools/apply-patch';

// Create a mock ToolContext
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

describe('patch_file tool', () => {
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

  it('patches an existing file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf-8');

    const patch = `@@ -1,3 +1,3 @@
 line1
-line2
+replaced
 line3`;

    const result = await applyPatchTool.execute({ file_path: filePath, patch }, ctx);
    expect(result).toContain('Successfully patched');

    const updated = readFileSync(filePath, 'utf-8');
    expect(updated).toBe('line1\nreplaced\nline3\n');
  });

  it('adds lines to an existing file', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'line1\nline2\n', 'utf-8');

    const patch = `@@ -1,2 +1,3 @@
 line1
+inserted
 line2`;

    const result = await applyPatchTool.execute({ file_path: filePath, patch }, ctx);
    expect(result).toContain('Successfully patched');

    const updated = readFileSync(filePath, 'utf-8');
    expect(updated).toBe('line1\ninserted\nline2\n');
  });

  it('creates a new file', async () => {
    const filePath = join(testDir, 'newfile.txt');

    const patch = `@@ -0,0 +1,2 @@
+hello
+world`;

    const result = await applyPatchTool.execute({ file_path: filePath, patch }, ctx);
    expect(result).toContain('Created new file');
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('hello\nworld\n');
  });

  it('rejects malformed patches', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'content\n', 'utf-8');

    const result = await applyPatchTool.execute(
      { file_path: filePath, patch: 'not a real patch' },
      ctx
    );
    expect(result).toContain('Error');
  });

  it('rejects patches with mismatched context', async () => {
    const filePath = join(testDir, 'test.txt');
    writeFileSync(filePath, 'completely different content\n', 'utf-8');

    const patch = `@@ -1,1 +1,1 @@
-wrong context
+something`;

    const result = await applyPatchTool.execute({ file_path: filePath, patch }, ctx);
    expect(result).toContain('Error');
    expect(result).toContain('Context mismatch');
  });
});
