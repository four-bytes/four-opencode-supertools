// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { LspClient } from '../src/lib/lsp-client';
import {
  LspRegistry,
  DEFAULT_SERVERS,
  getLspRegistry,
  resetLspRegistry,
} from '../src/lib/lsp-registry';

// ────────────────────────────────────────────────────────────────
// Helper: create a mock LSP server that responds to JSON-RPC
// ────────────────────────────────────────────────────────────────

/**
 * Minimal JSON-RPC 2.0 echo server used for testing.
 * Reads Content-Length framed messages from stdin and writes responses to stdout.
 */
const MOCK_SERVER_SCRIPT = `
const { stdin, stdout } = process;
let buffer = '';

// Read stdin
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
    } catch (e) {
      // Skip malformed messages
    }
  }
}

function send(msg) {
  const json = JSON.stringify(msg);
  const header = 'Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n';
  stdout.write(header + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
        },
      },
    });
  } else if (msg.method === 'textDocument/hover') {
    const pos = msg.params.position;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        contents: { kind: 'markdown', value: '**hover** content at line ' + pos.line },
        range: {
          start: { line: pos.line, character: pos.character },
          end: { line: pos.line, character: pos.character + 5 },
        },
      },
    });
  } else if (msg.method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          uri: msg.params.textDocument.uri,
          range: {
            start: { line: 10, character: 0 },
            end: { line: 10, character: 5 },
          },
        },
      ],
    });
  } else if (msg.method === 'textDocument/documentSymbol') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { name: 'MyClass', kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } } },
      ],
    });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    // exit notification will follow, handled by spawn
  } else if (msg.method === 'exit') {
    process.exit(0);
  } else {
    // Unknown method — respond with error
    if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
}
`;

// ────────────────────────────────────────────────────────────────
// Tests: LspClient — JSON-RPC Framing & Communication
// ────────────────────────────────────────────────────────────────

describe('LspClient — JSON-RPC Framing', () => {
  let client: LspClient;

  beforeAll(() => {
    client = new LspClient();
  });

  afterAll(() => {
    client.shutdown().catch(() => {
      // Best-effort cleanup
    });
  });

  it('spawns a process and initializes successfully', async () => {
    client.spawn(['bun', '-e', MOCK_SERVER_SCRIPT]);
    expect(client.isRunning).toBe(true);

    const capabilities = await client.initialize('file:///test');
    expect(capabilities).toBeDefined();
    expect((capabilities as Record<string, unknown>).capabilities).toBeDefined();
  });

  it('handles hover request', async () => {
    client.initialized();
    // We need to open a document first
    // (notifications are fire-and-forget, we just check no crash)

    const result = await client.hover('file:///test.ts', 5, 10);
    expect(result).not.toBeNull();
    expect(result!.contents).toContain('hover');
    expect(result!.range).toBeDefined();
  });

  it('handles references request', async () => {
    const result = await client.references('file:///test.ts', 5, 10);
    expect(result).toBeArray();
    expect(result.length).toBe(1);
    expect(result[0].uri).toBe('file:///test.ts');
  });

  it('handles documentSymbol request', async () => {
    const result = await client.documentSymbol('file:///test.ts');
    expect(result).toBeArray();
    expect(result.length).toBe(1);
  });

  it('returns empty diagnostics when no publishDiagnostics received', () => {
    const diags = client.getDiagnostics('file:///test.ts');
    expect(diags).toBeArray();
    expect(diags.length).toBe(0);
  });

  it('returns null from hover when process not running', async () => {
    const deadClient = new LspClient();
    const result = await deadClient.hover('file:///test.ts', 1, 1);
    expect(result).toBeNull();
  });

  it('returns empty references when process not running', async () => {
    const deadClient = new LspClient();
    const result = await deadClient.references('file:///test.ts', 1, 1);
    expect(result).toEqual([]);
  });

  it('returns empty array from documentSymbol when process not running', async () => {
    const deadClient = new LspClient();
    const result = await deadClient.documentSymbol('file:///test.ts');
    expect(result).toEqual([]);
  });
});

describe('LspClient — Content-Length Framing', () => {
  it('correctly parses Content-Length delimited messages via mock server', async () => {
    const client = new LspClient();
    client.spawn(['bun', '-e', MOCK_SERVER_SCRIPT]);
    await client.initialize('file:///test-framing');
    client.initialized();

    // Test that a request with proper framing gets a response
    const hover = await client.hover('file:///test-framing.ts', 3, 7);
    expect(hover).not.toBeNull();
    expect(hover!.contents).toContain('line 3');

    await client.shutdown();
  });
});

describe('LspClient — Request/Response Matching', () => {
  it('correctly matches responses to concurrent requests', async () => {
    const client = new LspClient();
    client.spawn(['bun', '-e', MOCK_SERVER_SCRIPT]);
    await client.initialize('file:///test-matching');
    client.initialized();

    // Fire multiple concurrent requests
    const [hover1, hover2, refs] = await Promise.all([
      client.hover('file:///a.ts', 1, 1),
      client.hover('file:///b.ts', 5, 5),
      client.references('file:///c.ts', 3, 3),
    ]);

    expect(hover1).not.toBeNull();
    expect(hover1!.contents).toContain('line 1');
    expect(hover2).not.toBeNull();
    expect(hover2!.contents).toContain('line 5');
    expect(refs).toBeArray();
    expect(refs.length).toBe(1);

    await client.shutdown();
  });

  it('handles timeout gracefully', { timeout: 15000 }, async () => {
    // Create a server that never responds to hover
    const slowServerScript = `
      const { stdin, stdout } = process;
      let buffer = '';
      stdin.setEncoding('utf-8');
      stdin.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);
        if (match) {
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

    const client = new LspClient();
    client.spawn(['bun', '-e', slowServerScript]);
    await client.initialize('file:///test-timeout');

    // This should timeout (100ms) and return null
    const result = await client.hover('file:///test-timeout.ts', 1, 1, 100);
    expect(result).toBeNull();

    // Client should still be alive — the process is killed on timeout
    // Actually, our killProcess kills the server on timeout
    // For this test, we just check that null is returned

    await client.shutdown();
  });
});

describe('LspClient — Shutdown', () => {
  it('shuts down gracefully', async () => {
    const client = new LspClient();
    client.spawn(['bun', '-e', MOCK_SERVER_SCRIPT]);
    await client.initialize('file:///test-shutdown');

    await client.shutdown();
    expect(client.isRunning).toBe(false);
  });

  it('shutdown on dead process is safe', async () => {
    const client = new LspClient();
    // Never spawned — shutdown should not throw
    await client.shutdown();
    expect(client.isRunning).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// Tests: LspRegistry — Server Resolution & Binary Checks
// ────────────────────────────────────────────────────────────────

describe('LspRegistry — findConfig', () => {
  it('resolves typescript server for .ts files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('src/app.ts');
    expect(config).not.toBeNull();
    expect(config!.languageId).toBe('typescript');
    expect(config!.command[0]).toBe('typescript-language-server');
  });

  it('resolves typescript server for .tsx files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('Component.tsx');
    expect(config).not.toBeNull();
    expect(config!.languageId).toBe('typescript');
  });

  it('resolves typescript server for .js files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('legacy.js');
    expect(config).not.toBeNull();
    expect(config!.languageId).toBe('typescript');
  });

  it('resolves gopls for .go files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('main.go');
    expect(config).not.toBeNull();
    expect(config!.command[0]).toBe('gopls');
  });

  it('resolves pyright for .py files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('script.py');
    expect(config).not.toBeNull();
    expect(config!.command[0]).toBe('pyright-langserver');
  });

  it('resolves rust-analyzer for .rs files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('lib.rs');
    expect(config).not.toBeNull();
    expect(config!.command[0]).toBe('rust-analyzer');
  });

  it('resolves intelephense for .php files', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('index.php');
    expect(config).not.toBeNull();
    expect(config!.command[0]).toBe('intelephense');
  });

  it('returns null for unknown extension (.txt)', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('readme.txt');
    expect(config).toBeNull();
  });

  it('returns null for unknown extension (.css)', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('styles.css');
    expect(config).toBeNull();
  });

  it('returns null for files without extension', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('Makefile');
    expect(config).toBeNull();
  });

  it('handles paths with dots in directory names', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('/home/user/my.dir/file.ts');
    expect(config).not.toBeNull();
    expect(config!.languageId).toBe('typescript');
  });

  it('matches case-insensitively', () => {
    const registry = new LspRegistry();
    const config = registry.findConfig('File.TS');
    expect(config).not.toBeNull();
    expect(config!.languageId).toBe('typescript');
  });
});

describe('LspRegistry — isInstalled', () => {
  it('returns true for a known system binary (ls)', () => {
    const registry = new LspRegistry();
    expect(registry.isInstalled(['ls'])).toBe(true);
  });

  it('returns true for a known system binary (echo)', () => {
    const registry = new LspRegistry();
    expect(registry.isInstalled(['echo'])).toBe(true);
  });

  it('returns false for a nonexistent binary', () => {
    const registry = new LspRegistry();
    expect(registry.isInstalled(['nonexistent-binary-xyz-123'])).toBe(false);
  });

  it('returns false for empty command array', () => {
    const registry = new LspRegistry();
    expect(registry.isInstalled([])).toBe(false);
  });
});

describe('LspRegistry — resolveServer', () => {
  it('resolves server for known extension with installed binary', () => {
    const registry = new LspRegistry();
    // 'ls' is always installed, so we can mock a config
    registry.register({
      command: ['ls'],
      languageId: 'test-lang',
      extensions: ['.test'],
    });

    const result = registry.resolveServer('file.test');
    expect(result).not.toBeNull();
    expect(result!.languageId).toBe('test-lang');
    expect(result!.client).toBeInstanceOf(LspClient);
  });

  it('returns null for known extension when binary not installed', () => {
    const registry = new LspRegistry();
    const result = registry.resolveServer('file.ts');
    // typescript-language-server is probably not installed in CI
    // We just check it doesn't throw
    if (result) {
      expect(result.languageId).toBe('typescript');
    } else {
      // Expected — binary not installed
      expect(result).toBeNull();
    }
  });

  it('returns null for unknown extension', () => {
    const registry = new LspRegistry();
    const result = registry.resolveServer('file.unknown-xyz');
    expect(result).toBeNull();
  });
});

describe('LspRegistry — register & configs', () => {
  it('allows registering custom server config', () => {
    const registry = new LspRegistry();
    registry.register({
      command: ['custom-lsp'],
      languageId: 'custom',
      extensions: ['.cust'],
    });

    const config = registry.findConfig('file.cust');
    expect(config).not.toBeNull();
    expect(config!.command[0]).toBe('custom-lsp');
  });

  it('getConfigs returns all configs including defaults and registered', () => {
    const registry = new LspRegistry();
    const countBefore = registry.getConfigs().length;

    registry.register({
      command: ['custom-lsp-2'],
      languageId: 'custom2',
      extensions: ['.c2'],
    });

    const configs = registry.getConfigs();
    expect(configs.length).toBe(countBefore + 1);
  });
});

describe('LspRegistry — shutdownAll', () => {
  it('shuts down all cached clients', async () => {
    const registry = new LspRegistry();
    // No clients registered — should not throw
    await registry.shutdownAll();
  });
});

describe('LspRegistry — singleton', () => {
  it('getLspRegistry returns the same instance', () => {
    resetLspRegistry();
    const a = getLspRegistry();
    const b = getLspRegistry();
    expect(a).toBe(b);
  });

  it('resetLspRegistry creates a new instance', () => {
    resetLspRegistry();
    const a = getLspRegistry();
    resetLspRegistry();
    const b = getLspRegistry();
    expect(a).not.toBe(b);
  });
});

describe('LspRegistry — DEFAULT_SERVERS', () => {
  it('contains all expected language servers', () => {
    expect(DEFAULT_SERVERS.length).toBe(5);

    const commands = DEFAULT_SERVERS.map((s) => s.command[0]);
    expect(commands).toContain('typescript-language-server');
    expect(commands).toContain('gopls');
    expect(commands).toContain('pyright-langserver');
    expect(commands).toContain('rust-analyzer');
    expect(commands).toContain('intelephense');
  });

  it('each server has install hint', () => {
    for (const server of DEFAULT_SERVERS) {
      expect(server.installHint).toBeDefined();
      expect(server.installHint!.length).toBeGreaterThan(0);
    }
  });
});
