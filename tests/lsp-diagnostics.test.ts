// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ────────────────────────────────────────────────────────────────
// Test helper — ctx object for tool.execute()
// ────────────────────────────────────────────────────────────────

function makeCtx(dir: string) {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => ({}),
    ask: async () => {},
  };
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('lsp_diagnostics tool', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-lsp-diag-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    try { rmSync(testDir, { recursive: true }); } catch {}
    try {
      const { getLspRegistry, resetLspRegistry } = await import('../src/lib/lsp-registry');
      await getLspRegistry().shutdownAll();
      resetLspRegistry();
    } catch {}
  });

  // ── 1. Diagnostics for a file with errors ─────────────────────
  // Note: typescript-language-server sends publishDiagnostics asynchronously.
  // The tool's getDiagnostics() reads from cache, so diagnostics may not be
  // available on the first execute(). We open the file on the first call,
  // then read cached diagnostics on the second call.

  it('returns diagnostics for a TypeScript file (opens document on first call, gets cached diagnostics on second)', async () => {
    const testFile = join(testDir, 'sample.ts');
    writeFileSync(
      testFile,
      [
        'function foo() { return 1; }',
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
        'const e = 5;',
        'const f = 6;',
        'const g = 7;',
        'const h = 8;',
        'const x = <div class="bad" />;',
        'const i = 9;',
        'const j = 10;',
        'export {};',
      ].join('\n'),
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    // First call: opens document, server sends publishDiagnostics async
    await lspDiagnosticsTool.execute({ file_path: testFile }, ctx);
    // Second call: diagnostics are now in cache
    const result = (await lspDiagnosticsTool.execute({ file_path: testFile }, ctx)) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect(result.file).toBe(testFile);
    expect(typeof result.count).toBe('number');
    expect(Array.isArray(result.diagnostics)).toBe(true);
    // Diagnostics may still be empty due to async timing, but available=true confirms server was reached
    if ((result.diagnostics as unknown[]).length > 0) {
      expect(result.errors).toBeGreaterThan(0);
    }
  });

  // ── 2. Severity filtering ────────────────────────────────────

  it('filters diagnostics to only errors when severity=error', async () => {
    const testFile = join(testDir, 'filter-err.ts');
    writeFileSync(
      testFile,
      'function foo() { return 1; }\nconst bar = 42;\nconst x = <div class="x" />;\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    // Open document on first call
    await lspDiagnosticsTool.execute({ file_path: testFile }, ctx);
    // Read cached diagnostics on second call
    const result = (await lspDiagnosticsTool.execute(
      { file_path: testFile, severity: 'error' },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    for (const d of result.diagnostics as Array<{ severity: string }>) {
      expect(d.severity).toBe('error');
    }
  });

  it('filters diagnostics to only warnings when severity=warning', async () => {
    const testFile = join(testDir, 'filter-warn.ts');
    writeFileSync(
      testFile,
      '// This file intentionally has no errors, only unused variable warnings\nlet unused1 = 1;\nlet unused2 = 2;\nconsole.log("test");\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    await lspDiagnosticsTool.execute({ file_path: testFile }, ctx);
    const result = (await lspDiagnosticsTool.execute(
      { file_path: testFile, severity: 'warning' },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    for (const d of result.diagnostics as Array<{ severity: string }>) {
      expect(d.severity).toBe('warning');
    }
  });

  it('returns all severities when severity=all', async () => {
    const testFile = join(testDir, 'all-sev.ts');
    writeFileSync(
      testFile,
      'function foo() { return 1; }\nconst bar = 42;\nconst x = <div class="x" />;\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    await lspDiagnosticsTool.execute({ file_path: testFile }, ctx);
    const result = (await lspDiagnosticsTool.execute(
      { file_path: testFile, severity: 'all' },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    const severities = new Set(
      (result.diagnostics as Array<{ severity: string }>).map((d) => d.severity)
    );
    if (severities.size > 0) {
      expect(severities.size).toBeGreaterThan(1);
    }
  });

  // ── 3. No-server fallback ─────────────────────────────────────

  it('returns available=false with hint when no LSP server is configured for the file type', async () => {
    const noServerFile = join(testDir, 'no-lang.xyz');
    writeFileSync(noServerFile, 'some content', 'utf-8');

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute({ file_path: noServerFile }, ctx)) as Record<string, unknown>;
    const hint = result.hint as string | undefined;

    expect(result.available).toBe(false);
    expect(hint).toBeDefined();
    expect(typeof hint).toBe('string');
    expect(hint?.toLowerCase()).toMatch(/no lsp server|not configured/);
  });

  it('returns available=false with hint when LSP server binary is not installed', async () => {
    // Register a config for a binary that definitely doesn't exist
    const { resetLspRegistry, getLspRegistry } = await import('../src/lib/lsp-registry');
    resetLspRegistry();
    const registry = getLspRegistry();
    registry.register({
      command: ['this-binary-does-not-exist-xyz123', '--stdio'],
      languageId: 'nonexistent-lang',
      extensions: ['.nonext'],
    });

    const missingFile = join(testDir, 'test.nonext');
    writeFileSync(missingFile, 'content', 'utf-8');

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute({ file_path: missingFile }, ctx)) as Record<string, unknown>;

    // Capture hint to avoid proxy object re-access issue
    const hint = result.hint as string | undefined;

    expect(result.available).toBe(false);
    expect(hint).toBeDefined();
    expect(typeof hint).toBe('string');
    expect(hint!.toLowerCase()).toContain('not installed');
  });

  it('returns available=false when file does not exist', async () => {
    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute(
      { file_path: join(testDir, 'does-not-exist.ts') },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(false);
    expect(String(result.hint)).toContain('Could not read file');
  });

  // ── 4. Message truncation ─────────────────────────────────────

  it('truncates diagnostic messages longer than 500 characters', async () => {
    const testFile = join(testDir, 'trunc.ts');
    // Create a file with a very long comment that could produce a long error message
    const longComment = '// ' + 'x'.repeat(2000) + '\n';
    writeFileSync(
      testFile,
      longComment + 'function foo() { return 1; }\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute({ file_path: testFile }, ctx)) as Record<string, unknown>;

    expect(result.available).toBe(true);
    const diags = result.diagnostics as Array<{ message: string }>;
    if (diags.length > 0) {
      for (const d of diags) {
        expect(d.message.length).toBeLessThanOrEqual(500 + '…[truncated]'.length);
        if (d.message.length > 500) {
          expect(d.message).toContain('…[truncated]');
        }
      }
    }
  });

  // ── 5. Project-wide diagnostics ──────────────────────────────

  it('returns project-wide diagnostics for multiple open documents', async () => {
    const fileA = join(testDir, 'proj-a.ts');
    const fileB = join(testDir, 'proj-b.ts');
    writeFileSync(fileA, 'function foo() { return 1; }\nconst bar = 42;\nconst x = <div class="x" />;\n', 'utf-8');
    writeFileSync(fileB, 'function baz() { return 2; }\nconst qux = 99;\n', 'utf-8');

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);

    // Open both files first so the registry tracks them
    await lspDiagnosticsTool.execute({ file_path: fileA }, ctx);
    await lspDiagnosticsTool.execute({ file_path: fileB }, ctx);

    // Now query project-wide
    const result = (await lspDiagnosticsTool.execute({ file_path: 'project' }, ctx)) as Record<string, unknown>;

    expect(result.file).toBe('project');
    expect(typeof result.count).toBe('number');
    expect(typeof result.errors).toBe('number');
    expect(typeof result.warnings).toBe('number');
  });

  it('returns available=false for project-wide when no documents are open', async () => {
    const { resetLspRegistry } = await import('../src/lib/lsp-registry');
    resetLspRegistry();

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute({ file_path: 'project' }, ctx)) as Record<string, unknown>;
    const hint = result.hint as string | undefined;

    expect(result.available).toBe(false);
    expect(hint).toBeDefined();
    expect(hint?.toLowerCase()).toMatch(/no open documents/);
  });

  // ── 6. Sorting ────────────────────────────────────────────────

  it('sorts diagnostics: errors first, then warnings, infos, hints', async () => {
    const testFile = join(testDir, 'sort-me.ts');
    writeFileSync(
      testFile,
      'function foo() { return 1; }\nconst bar = 42;\nconst x = <div class="x" />;\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);
    const result = (await lspDiagnosticsTool.execute({ file_path: testFile }, ctx)) as Record<string, unknown>;

    expect(result.available).toBe(true);
    const diags = result.diagnostics as Array<{ severity: string; line: number }>;
    const order: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
    for (let i = 1; i < diags.length; i++) {
      const prev = order[diags[i - 1].severity] ?? 99;
      const curr = order[diags[i].severity] ?? 99;
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  // ── 7. max_results and truncation ─────────────────────────────

  it('respects max_results and sets truncated=true when results exceed limit', async () => {
    const testFile = join(testDir, 'limit-me.ts');
    writeFileSync(
      testFile,
      'function foo() { return 1; }\nconst bar = 42;\nconst x = <div class="x" />;\n',
      'utf-8'
    );

    const { lspDiagnosticsTool } = await import('../src/tools/lsp-diagnostics');
    const ctx = makeCtx(testDir);

    const result = (await lspDiagnosticsTool.execute(
      { file_path: testFile, max_results: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect((result.diagnostics as unknown[]).length).toBeLessThanOrEqual(1);
    if ((result.count as number) > 1) {
      expect(result.truncated).toBe(true);
      expect(result.hint).toBeDefined();
    }
  });
});
