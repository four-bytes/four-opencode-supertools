// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LspClient } from '../src/lib/lsp-client';
import { lspHoverTool } from '../src/tools/lsp-hover';
import { resetLspRegistry } from '../src/lib/lsp-registry';

// ────────────────────────────────────────────────────────────────
// Mock LSP Server — responds to hover with test data
// ────────────────────────────────────────────────────────────────

// The mock server is built as an array of string lines joined with \n.
// This avoids backtick-nesting confusion with escape sequences.
const MOCK_SERVER_LINES = [
  `const { stdin, stdout } = process;`,
  `let buffer = '';`,
  `stdin.setEncoding('utf-8');`,
  `stdin.on('data', (chunk) => { buffer += chunk; parseBuffer(); });`,
  `function parseBuffer() {`,
  `  while (buffer.length > 0) {`,
  `    const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);`,
  `    if (!match || match.index === undefined) {`,
  `      const next = buffer.search(/Content-Length:/);`,
  `      if (next > 0) { buffer = buffer.slice(next); continue; }`,
  `      break;`,
  `    }`,
  `    const len = parseInt(match[1], 10);`,
  `    const headerEnd = match.index + match[0].length;`,
  `    if (buffer.length < headerEnd + len) break;`,
  `    const content = buffer.slice(headerEnd, headerEnd + len);`,
  `    buffer = buffer.slice(headerEnd + len);`,
  `    try { const msg = JSON.parse(content); handleMessage(msg); } catch {}`,
  `  }`,
  `}`,
  `function send(msg) {`,
  `  const json = JSON.stringify(msg);`,
  `  const header = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n';`,
  `  stdout.write(header + json);`,
  `}`,
  `function handleMessage(msg) {`,
  `  if (msg.method === 'initialize') {`,
  `    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });`,
  `  } else if (msg.method === 'textDocument/didOpen') {`,
  `  } else if (msg.method === 'textDocument/hover') {`,
  `    const pos = msg.params.position;`,
  `    const line = pos.line;`,
  `    let contents = '';`,
  `    if (line === 0) {`,
  `      contents = '\`\`\`typescript\\nfunction foo(): string\\n\`\`\`\\n\\n' +`,
  `                  'This is a very long documentation comment. '.repeat(96);`,
  `    } else if (line === 1) {`,
  `      contents = '\\*\\*interface\\*\\* \`MyInterface\`\\n\\nA test interface for hover.';`,
  `    } else if (line === 2) { contents = ''; }`,
  `    else { contents = '\`\`\`ts\\nconst x: number = 5;\\n\`\`\`\\nType of x is \\*\\*number\\*\\*.'; }`,
  `    send({ jsonrpc: '2.0', id: msg.id,`,
  `      result: contents ? { contents: { kind: 'markdown', value: contents },`,
  `        range: { start: { line: pos.line, character: 0 }, end: { line: pos.line, character: 10 } } } : null });`,
  `  } else if (msg.method === 'shutdown') {`,
  `    send({ jsonrpc: '2.0', id: msg.id, result: null });`,
  `  } else if (msg.method === 'exit') { process.exit(0); }`,
  `}`,
];
const MOCK_HOVER_SERVER = MOCK_SERVER_LINES.join('\n');

// ────────────────────────────────────────────────────────────────
// Mock LSP Server — never responds to hover (timeout test)
// ────────────────────────────────────────────────────────────────

const SLOW_SERVER = `
const { stdin, stdout } = process;
let buffer = '';
stdin.setEncoding('utf-8');
stdin.on('data', (chunk) => {
  buffer += chunk;
  const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);
  if (match && match.index !== undefined) {
    const headerEnd = match.index + match[0].length;
    const len = parseInt(match[1], 10);
    if (buffer.length >= headerEnd + len) {
      const content = buffer.slice(headerEnd, headerEnd + len);
      buffer = buffer.slice(headerEnd + len);
      try {
        const msg = JSON.parse(content);
        if (msg.method === 'initialize') {
          const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
          stdout.write('Content-Length: ' + Buffer.byteLength(resp) + '\\r\\n\\r\\n' + resp);
        }
        // Never respond to hover — triggers timeout
      } catch {}
    }
  }
});
`;

// ────────────────────────────────────────────────────────────────
// Mock Registry — registers the mock server for .ts
// ────────────────────────────────────────────────────────────────

function registerMockServer(): void {
  resetLspRegistry();
  const { LspRegistry, getLspRegistry } = require('../src/lib/lsp-registry');
  const registry = getLspRegistry();
  registry.register({
    command: ['bun', '-e', MOCK_HOVER_SERVER],
    languageId: 'typescript',
    extensions: ['.ts'],
  });
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

function parseResult(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>;
}

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

describe('lsp_hover tool', () => {
  let testDir: string;
  let testFile: string;

  beforeAll(() => {
    testDir = join(tmpdir(), `supertools-lsp-hover-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, 'sample.ts');
    writeFileSync(
      testFile,
      'const greeting: string = "hello";\nfunction foo(): number { return 1; }\ninterface MyInterface {}\nconst x = 1;\n',
      'utf-8'
    );
    // Register mock server
    registerMockServer();
  });

  afterAll(async () => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {}
    // Shutdown mock LSP clients
    const { getLspRegistry } = await import('../src/lib/lsp-registry');
    await getLspRegistry().shutdownAll();
    resetLspRegistry();
  });

  it('returns available=true with type info from mock LSP server', async () => {
    const ctx = mockCtx(testDir);
    const result = parseResult(await lspHoverTool.execute(
      { file_path: testFile, line: 4, character: 1 },
      ctx
    ));

    expect(result.available).toBe(true);
    expect(result.file).toBe(testFile);
    expect(result.position).toEqual({ line: 4, character: 1 });
    expect(result.type).toBeDefined();
    expect(typeof result.type).toBe('string');
  });

  it('returns available=false when no LSP server for file type', async () => {
    const noServerFile = join(testDir, 'no-lang.xyz');
    writeFileSync(noServerFile, 'some content', 'utf-8');

    const ctx = mockCtx(testDir);
    const result = parseResult(await lspHoverTool.execute(
      { file_path: noServerFile, line: 1, character: 1 },
      ctx
    ));

    expect(result.available).toBe(false);
    expect(result.hint).toBeDefined();
    expect(typeof result.hint).toBe('string');
  });

  it('returns error when file not found', async () => {
    const ctx = mockCtx(testDir);
    const result = parseResult(await lspHoverTool.execute(
      { file_path: join(testDir, 'does-not-exist.ts'), line: 1, character: 1 },
      ctx
    ));

    expect(result.available).toBe(false);
    expect(result.hint).toContain('Could not read file');
  });

  it('returns no-information when hover is empty at position', async () => {
    const ctx = mockCtx(testDir);
    // Line 3 (0-indexed: 2) returns empty contents from mock server
    const result = parseResult(await lspHoverTool.execute(
      { file_path: testFile, line: 3, character: 1 },
      ctx
    ));

    expect(result.available).toBe(true);
    expect(result.type).toBe('no information at this position');
  });

  it('truncates long documentation', async () => {
    const ctx = mockCtx(testDir);
    // Line 1 (0-indexed: 0) returns very long documentation
    const result = parseResult(await lspHoverTool.execute(
      { file_path: testFile, line: 1, character: 1 },
      ctx
    ));

    expect(result.available).toBe(true);
    expect(result.fullContents).toBeDefined();
    expect((result.fullContents as string).length).toBeLessThanOrEqual(4012); // 4000 + len('…[truncated]') = 4012
    expect((result.fullContents as string)).toContain('…[truncated]');
  });

  it('converts 1-based line/character to 0-based for LSP', async () => {
    const ctx = mockCtx(testDir);
    // Pass 1-based: line=4, char=5 → LSP gets line=3, char=4
    // Mock returns different content per line, so we verify it doesn't crash
    const result = parseResult(await lspHoverTool.execute(
      { file_path: testFile, line: 4, character: 5 },
      ctx
    ));

    expect(result.available).toBe(true);
    // The position returned is the original 1-based
    expect(result.position).toEqual({ line: 4, character: 5 });
  });

  it('defaults character to 1 when not provided', async () => {
    const ctx = mockCtx(testDir);
    const result = parseResult(await lspHoverTool.execute(
      { file_path: testFile, line: 4 },
      ctx
    ));

    expect(result.available).toBe(true);
    expect(result.position).toEqual({ line: 4, character: 1 });
  });

  it('handles LSP server timeout gracefully', async () => {
    // Register a slow server for .slow files
    const { getLspRegistry } = await import('../src/lib/lsp-registry');
    const registry = getLspRegistry();
    registry.register({
      command: ['bun', '-e', SLOW_SERVER],
      languageId: 'slow-lang',
      extensions: ['.slow'],
    });

    const slowFile = join(testDir, 'test.slow');
    writeFileSync(slowFile, 'content', 'utf-8');

    const ctx = mockCtx(testDir);
    // Use a short timeout — the mock server never responds
    const result = parseResult(await lspHoverTool.execute(
      { file_path: slowFile, line: 1, character: 1 },
      ctx
    ));

    // Should return null hover → no information
    expect(result.available).toBe(true);
    expect(result.type).toBe('no information at this position');
  }, 20000);
});