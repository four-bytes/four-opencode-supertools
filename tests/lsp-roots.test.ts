import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  canonicalRoot,
  findConfigRoot,
  resolveCargoWorkspaceRoot,
  resolveGoRoot,
  resolveProjectRoot,
} from '../src/lib/lsp-roots';
import {
  DEFAULT_SERVERS,
  LspRegistry,
  applyServerOverrides,
  selectServerConfig,
} from '../src/lib/lsp-registry';
import { clearConfigCache } from '../src/lib/framework/config';

let dir: string;

function write(path: string, content = ''): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  dir = mkdtempSync(join(tmpdir(), 'supertools-lsp-roots-'));
  clearConfigCache();
});

afterEach(() => {
  clearConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

describe('LSP server selection', () => {
  it('selects deno lsp when deno.json is the nearest marker', () => {
    write('project/deno.json', '{}');
    const file = write('project/src/main.ts', '');
    expect(selectServerConfig(file, DEFAULT_SERVERS)?.id).toBe('deno');
  });

  it('selects typescript-language-server in a Node/Bun project', () => {
    write('project/package.json', '{}');
    const file = write('project/src/main.ts', '');
    expect(selectServerConfig(file, DEFAULT_SERVERS)?.id).toBe('typescript');
  });

  it('prefers deno when both markers share a directory', () => {
    write('project/deno.json', '{}');
    write('project/package.json', '{}');
    const file = write('project/src/main.ts', '');
    expect(selectServerConfig(file, DEFAULT_SERVERS)?.id).toBe('deno');
  });

  it('falls back to the base server without any marker', () => {
    const file = write('bare/main.ts', '');
    expect(selectServerConfig(file, DEFAULT_SERVERS)?.id).toBe('typescript');
  });

  it('ignores disabled servers', () => {
    write('project/package.json', '{}');
    const file = write('project/src/main.ts', '');
    const configs = applyServerOverrides(DEFAULT_SERVERS, [
      { id: 'typescript', disable: true },
      { id: 'deno', disable: true },
    ]);
    expect(selectServerConfig(file, configs)).toBeNull();
  });

  it('adds a server from config overrides', () => {
    const file = write('project/main.cust', '');
    const configs = applyServerOverrides(DEFAULT_SERVERS, [
      {
        id: 'custom',
        command: ['custom-lsp'],
        languageId: 'custom',
        extensions: ['.cust'],
      },
    ]);
    expect(selectServerConfig(file, configs)?.command[0]).toBe('custom-lsp');
  });
});

describe('LSP project root resolution', () => {
  it('uses the nearest tsconfig.json', () => {
    write('project/tsconfig.json', '{}');
    write('project/package.json', '{}');
    const file = write('project/src/deep/a.ts', '');
    const root = resolveProjectRoot(file, {
      rootMarkers: ['tsconfig.json', 'package.json'],
    });
    expect(root).toBe(canonicalRoot(join(dir, 'project')));
  });

  it('falls back to package.json', () => {
    write('project/package.json', '{}');
    const file = write('project/src/a.ts', '');
    expect(resolveProjectRoot(file, { rootMarkers: ['tsconfig.json', 'package.json'] })).toBe(
      canonicalRoot(join(dir, 'project'))
    );
  });

  it('prefers go.work over a nested go.mod', () => {
    write('mono/go.work', 'go 1.22\n');
    write('mono/app/go.mod', 'module example.com/app\n');
    const file = write('mono/app/pkg/x.go', '');
    expect(resolveGoRoot(file)).toBe(canonicalRoot(join(dir, 'mono')));
    expect(resolveProjectRoot(file, { rootStrategy: 'go-work' })).toBe(
      canonicalRoot(join(dir, 'mono'))
    );
  });

  it('uses the nearest go.mod without a go.work', () => {
    write('app/go.mod', 'module example.com/app\n');
    const file = write('app/pkg/x.go', '');
    expect(resolveGoRoot(file)).toBe(canonicalRoot(join(dir, 'app')));
  });

  it('uses the nearest composer.json for PHP', () => {
    write('shop/composer.json', '{}');
    const file = write('shop/src/Service.php', '');
    expect(resolveProjectRoot(file, { rootMarkers: ['composer.json'] })).toBe(
      canonicalRoot(join(dir, 'shop'))
    );
  });

  it('uses the outermost Cargo workspace root, not a member crate', () => {
    write('ws/Cargo.toml', '[workspace]\nmembers = ["crates/a", "crates/b"]\n');
    write('ws/crates/a/Cargo.toml', '[package]\nname = "a"\nversion = "0.1.0"\n');
    write('ws/crates/b/Cargo.toml', '[package]\nname = "b"\nversion = "0.1.0"\n');
    const a = write('ws/crates/a/src/lib.rs', '');
    const b = write('ws/crates/b/src/lib.rs', '');

    expect(resolveCargoWorkspaceRoot(a)).toBe(canonicalRoot(join(dir, 'ws')));
    expect(resolveCargoWorkspaceRoot(b)).toBe(canonicalRoot(join(dir, 'ws')));
  });

  it('honours package.workspace pointing at the workspace root', () => {
    write('ws2/Cargo.toml', '[workspace]\nmembers = ["crates/c"]\n');
    write(
      'ws2/crates/c/Cargo.toml',
      '[package]\nname = "c"\nversion = "0.1.0"\nworkspace = "../.."\n'
    );
    const file = write('ws2/crates/c/src/lib.rs', '');
    expect(resolveCargoWorkspaceRoot(file)).toBe(canonicalRoot(join(dir, 'ws2')));
  });

  it('uses the standalone crate when no ancestor declares [workspace]', () => {
    write('solo/Cargo.toml', '[package]\nname = "solo"\nversion = "0.1.0"\n');
    const file = write('solo/src/lib.rs', '');
    expect(resolveCargoWorkspaceRoot(file)).toBe(canonicalRoot(join(dir, 'solo')));
  });

  it('finds the nearest .supertools.json root', () => {
    write('project/.supertools.json', '{}');
    const file = write('project/src/a.ts', '');
    expect(findConfigRoot(file)).toBe(canonicalRoot(join(dir, 'project')));
  });
});

describe('LSP client pool and idle shutdown', () => {
  it('reuses one client within the timeout and evicts it afterwards', async () => {
    const marker = join(dir, 'exit.marker');
    const file = write('pool/main.fake', '');
    const registry = new LspRegistry(
      [
        {
          id: 'fake',
          command: ['bun', '-e', MOCK_SERVER(marker)],
          languageId: 'fake',
          extensions: ['.fake'],
        },
      ],
      { idleTimeoutMs: 120 }
    );

    const first = registry.resolveServer(file, { configRoot: dir });
    const second = registry.resolveServer(file, { configRoot: dir });
    expect(first).not.toBeNull();
    expect(second?.client).toBe(first?.client);
    expect(registry.poolSize).toBe(1);

    await sleep(400);
    expect(registry.poolSize).toBe(0);
    expect(existsSync(marker)).toBe(true);

    const third = registry.resolveServer(file, { configRoot: dir });
    expect(third).not.toBeNull();
    expect(third?.client).not.toBe(first?.client);
    expect(registry.poolSize).toBe(1);

    await registry.shutdownAll();
    expect(registry.poolSize).toBe(0);
  });

  it('does not evict when idle shutdown is disabled', async () => {
    const marker = join(dir, 'never.marker');
    const file = write('pinned/main.fake', '');
    const registry = new LspRegistry(
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

    const first = registry.resolveServer(file, { configRoot: dir });
    await sleep(250);
    expect(registry.poolSize).toBe(1);
    expect(existsSync(marker)).toBe(false);

    await registry.dispose();
    expect(registry.poolSize).toBe(0);
    expect(first).not.toBeNull();
  });

  it('pools member crates together and separates Cargo workspaces', async () => {
    const marker = join(dir, 'rust-exit.marker');
    write('ws1/Cargo.toml', '[workspace]\nmembers = ["crates/a", "crates/b"]\n');
    write('ws1/crates/a/Cargo.toml', '[package]\nname = "a"\nversion = "0.1.0"\n');
    write('ws1/crates/b/Cargo.toml', '[package]\nname = "b"\nversion = "0.1.0"\n');
    write('ws2/Cargo.toml', '[workspace]\nmembers = ["crates/c"]\n');
    write('ws2/crates/c/Cargo.toml', '[package]\nname = "c"\nversion = "0.1.0"\n');
    const memberA = write('ws1/crates/a/src/lib.rs', '');
    const memberB = write('ws1/crates/b/src/lib.rs', '');
    const otherWorkspace = write('ws2/crates/c/src/lib.rs', '');

    const registry = new LspRegistry(
      [
        {
          id: 'fake-rust',
          command: ['bun', '-e', MOCK_SERVER(marker)],
          languageId: 'rust',
          extensions: ['.rs'],
          markers: ['Cargo.toml'],
          rootStrategy: 'cargo-workspace',
        },
      ],
      { idleTimeoutMs: -1 }
    );

    const first = registry.resolveServer(memberA, { configRoot: dir });
    const sameWorkspace = registry.resolveServer(memberB, { configRoot: dir });
    const other = registry.resolveServer(otherWorkspace, { configRoot: dir });

    expect(first?.client).toBe(sameWorkspace?.client);
    expect(other?.client).not.toBe(first?.client);
    expect(registry.poolSize).toBe(2);

    await registry.shutdownAll();
  });
});
