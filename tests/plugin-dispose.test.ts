// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { PluginInput } from '@opencode-ai/plugin';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import FourOpencodeSupertools from '../src/four-opencode-supertools';
import { getLspRegistry, peekLspRegistry, resetLspRegistry } from '../src/lib/lsp-registry';

let dir: string;

function write(path: string, content = ''): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function pluginContext(): PluginInput {
  return {
    directory: dir,
    worktree: dir,
  } as unknown as PluginInput;
}

const MOCK_SERVER = (marker: string) => `
const { stdin, stdout } = process;
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
let buffer = '';
stdin.setEncoding('utf-8');
stdin.on('data', (chunk) => { buffer += chunk; parse(); });
function parse() {
  while (true) {
    const match = buffer.match(/^Content-Length: (\\d+)\\r\\n\\r\\n/);
    if (!match) break;
    const length = parseInt(match[1], 10);
    const start = match[0].length;
    if (buffer.length < start + length) break;
    const body = buffer.slice(start, start + length);
    buffer = buffer.slice(start + length);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    handle(msg);
  }
}
function send(msg) {
  const json = JSON.stringify(msg);
  stdout.write('Content-Length: ' + Buffer.byteLength(json) + '\\r\\n\\r\\n' + json);
}
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    fs.writeFileSync(marker, 'exit');
    process.exit(0);
  }
}
`;

beforeEach(() => {
  resetLspRegistry();
  dir = mkdtempSync(join(tmpdir(), 'supertools-plugin-dispose-'));
});

afterEach(() => {
  resetLspRegistry();
  rmSync(dir, { recursive: true, force: true });
});

describe('LSP registry singleton peek', () => {
  it('is null before creation and returns the same instance afterwards', () => {
    expect(peekLspRegistry()).toBeNull();

    const registry = getLspRegistry();
    expect(peekLspRegistry()).toBe(registry);
  });
});

describe('plugin dispose hook', () => {
  it('is returned by the entry and is a no-op without a registry', async () => {
    const hooks = await FourOpencodeSupertools(pluginContext(), {});

    expect(typeof hooks.dispose).toBe('function');
    expect(peekLspRegistry()).toBeNull();

    await hooks.dispose?.();

    expect(peekLspRegistry()).toBeNull();
  });

  it('shuts down a pooled fake LSP client', async () => {
    const marker = join(dir, 'exit.marker');
    const file = write('plugin/main.fake');

    const registry = getLspRegistry(
      [
        {
          id: 'fake',
          command: ['bun', '-e', MOCK_SERVER(marker)],
          languageId: 'fake',
          extensions: ['.fake'],
        },
      ],
      { idleTimeoutMs: -1 }
    );

    const resolved = registry.resolveServer(file, { configRoot: dir });
    expect(resolved).not.toBeNull();
    expect(registry.poolSize).toBe(1);
    expect(existsSync(marker)).toBe(false);

    const hooks = await FourOpencodeSupertools(pluginContext(), {});
    await hooks.dispose?.();

    expect(registry.poolSize).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
});
