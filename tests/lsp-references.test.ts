// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lspReferencesTool } from '../src/tools/lsp-references';
import { resetLspRegistry } from '../src/lib/lsp-registry';

// ────────────────────────────────────────────────────────────────
// Mock LSP Server — responds to references with test data
// ────────────────────────────────────────────────────────────────

const MOCK_REFS_SERVER = `
const { stdin, stdout } = process;
let buffer = '';

stdin.setEncoding('utf-8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  parseBuffer();
});

function parseBuffer() {
  while (buffer.length > 0) {
    const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);
    if (!match || match.index === undefined) {
      const next = buffer.search(/Content-Length:/);
      if (next > 0) { buffer = buffer.slice(next); continue; }
      break;
    }
    const len = parseInt(match[1], 10);
    const headerEnd = match.index + match[0].length;
    if (buffer.length < headerEnd + len) break;

    const content = buffer.slice(headerEnd, headerEnd + len);
    buffer = buffer.slice(headerEnd + len);

    try {
      const msg = JSON.parse(content);
      handleMessage(msg);
    } catch {}
  }
}

function send(msg) {
  const json = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n';
  stdout.write(header + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { referencesProvider: true } } });
  } else if (msg.method === 'initialized') {
    // fire-and-forget
  } else if (msg.method === 'textDocument/didOpen') {
    // fire-and-forget
  } else if (msg.method === 'textDocument/references') {
    const pos = msg.params.position;

    // Return references based on position
    let locations = [];
    if (pos.line === 0) {
      // Line 1: return multiple references across files
      locations = [
        { uri: 'file://' + process.cwd() + '/src/foo.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } },
        { uri: 'file://' + process.cwd() + '/src/bar.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 13 } } },
        { uri: 'file://' + process.cwd() + '/src/foo.ts', range: { start: { line: 10, character: 5 }, end: { line: 10, character: 15 } } },
        { uri: 'file://' + process.cwd() + '/tests/foo.test.ts', range: { start: { line: 2, character: 2 }, end: { line: 2, character: 12 } } },
      ];
    } else if (pos.line === 1) {
      // Line 2: single reference
      locations = [
        { uri: 'file://' + process.cwd() + '/src/bar.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 8 } } },
      ];
    } else {
      // No references at this position
      locations = [];
    }

    send({ jsonrpc: '2.0', id: msg.id, result: locations });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}
`;

// ────────────────────────────────────────────────────────────────
// Mock LSP Server — returns many references (truncation test)
// ────────────────────────────────────────────────────────────────

const MANY_REFS_SERVER = `
const { stdin, stdout } = process;
let buffer = '';
stdin.setEncoding('utf-8');
stdin.on('data', (chunk) => { buffer += chunk; parseBuffer(); });

function parseBuffer() {
  while (buffer.length > 0) {
    const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);
    if (!match || match.index === undefined) { const next = buffer.search(/Content-Length:/); if (next > 0) { buffer = buffer.slice(next); continue; } break; }
    const len = parseInt(match[1], 10);
    const headerEnd = match.index + match[0].length;
    if (buffer.length < headerEnd + len) break;
    const content = buffer.slice(headerEnd, headerEnd + len);
    buffer = buffer.slice(headerEnd + len);
    try { const msg = JSON.parse(content); handleMessage(msg); } catch {}
  }
}

function send(msg) {
  const json = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n';
  stdout.write(header + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { referencesProvider: true } } });
  } else if (msg.method === 'textDocument/references') {
    // Return 75 references to test truncation
    const locations = Array.from({ length: 75 }, (_, i) => ({
      uri: 'file://' + process.cwd() + '/src/file' + i + '.ts',
      range: { start: { line: i, character: 0 }, end: { line: i, character: 5 } },
    }));
    send({ jsonrpc: '2.0', id: msg.id, result: locations });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}
`;

// ────────────────────────────────────────────────────────────────
// Mock Registry — registers the mock server for .ts
// ────────────────────────────────────────────────────────────────

function registerMockServer(): void {
  resetLspRegistry();
  const { getLspRegistry } = require('../src/lib/lsp-registry');
  const registry = getLspRegistry();
  registry.register({
    command: ['bun', '-e', MOCK_REFS_SERVER],
    languageId: 'typescript',
    extensions: ['.ts'],
  });
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

function mockCtx(dir: string) {
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

describe('lsp_references tool', () => {
  let testDir: string;
  let testFile: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `supertools-lsp-refs-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'sample.ts');
    writeFileSync(
      testFile,
      'const greeting: string = "hello";\nfunction foo(): number { return 1; }\nconst x = 1;\nconst y = 2;\n',
      'utf-8'
    );
    registerMockServer();
  });

  afterAll(async () => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {}
    const { getLspRegistry } = await import('../src/lib/lsp-registry');
    await getLspRegistry().shutdownAll();
    resetLspRegistry();
  });

  it('returns available=true with references from mock LSP server', async () => {
    const ctx = mockCtx(testDir);
    const result = (await lspReferencesTool.execute(
      { file_path: testFile, line: 1, character: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect(result.file).toBe(testFile);
    expect(result.position).toEqual({ line: 1, character: 1 });
    expect(result.count).toBeGreaterThan(0);
    expect(Array.isArray(result.references)).toBe(true);
    expect((result.references as unknown[]).length).toBe(result.count);
  });

  it('returns available=false when no LSP server for file type', async () => {
    const noServerFile = join(testDir, 'no-lang.xyz');
    writeFileSync(noServerFile, 'some content', 'utf-8');

    const ctx = mockCtx(testDir);
    const result = (await lspReferencesTool.execute(
      { file_path: noServerFile, line: 1, character: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(false);
    expect(result.hint).toBeDefined();
    expect(typeof result.hint).toBe('string');
    expect(result.count).toBe(0);
  });

  it('returns error when file not found', async () => {
    const ctx = mockCtx(testDir);
    const result = (await lspReferencesTool.execute(
      { file_path: join(testDir, 'does-not-exist.ts'), line: 1, character: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(false);
    expect(result.hint).toContain('Could not read file');
  });

  it('returns empty references when none found at position', async () => {
    const ctx = mockCtx(testDir);
    // Line 4 returns no references from mock server
    const result = (await lspReferencesTool.execute(
      { file_path: testFile, line: 4, character: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect(result.count).toBe(0);
    expect(result.references).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('converts 1-based line/character to 0-based for LSP', async () => {
    const ctx = mockCtx(testDir);
    // Pass 1-based: line=2, char=5 → LSP gets line=1, char=4
    const result = (await lspReferencesTool.execute(
      { file_path: testFile, line: 2, character: 5 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    // The position returned is the original 1-based
    expect(result.position).toEqual({ line: 2, character: 5 });
  });

  it('defaults character to 1 when not provided', async () => {
    const ctx = mockCtx(testDir);
    const result = (await lspReferencesTool.execute(
      { file_path: testFile, line: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect(result.position).toEqual({ line: 1, character: 1 });
  });

  it('truncates results when max_results is exceeded', async () => {
    // Register many-refs server for .many files
    const { getLspRegistry } = await import('../src/lib/lsp-registry');
    const registry = getLspRegistry();
    registry.register({
      command: ['bun', '-e', MANY_REFS_SERVER],
      languageId: 'many-lang',
      extensions: ['.many'],
    });

    const manyFile = join(testDir, 'test.many');
    writeFileSync(manyFile, 'content', 'utf-8');

    const ctx = mockCtx(testDir);
    const result = (await lspReferencesTool.execute(
      { file_path: manyFile, line: 1, character: 1, max_results: 10 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.count).toBe(10);
    expect(result.hint).toContain('…and 65 more');
    expect(result.hint).toContain('75');
  });

  it('returns references with 1-based line/character in output', async () => {
    const ctx = mockCtx(testDir);
    // Line 1 returns 4 references with specific positions from mock server
    const result = (await lspReferencesTool.execute(
      { file_path: testFile, line: 1, character: 1 },
      ctx
    )) as Record<string, unknown>;

    expect(result.available).toBe(true);
    const refs = result.references as Array<{ line: number; character: number }>;
    for (const ref of refs) {
      expect(ref.line).toBeGreaterThan(0); // 1-based
      expect(ref.character).toBeGreaterThan(0); // 1-based
    }
  });
});
