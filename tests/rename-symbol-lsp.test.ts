// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin';
import {
  createRenameSymbolTool,
  renameSymbol,
  type RenameClientLike,
  type RenameRegistryLike,
} from '../src/tools/rename-symbol';
import { getLspRegistry, resetLspRegistry } from '../src/lib/lsp-registry';
import type { LspTextEdit, LspWorkspaceEdit, PrepareRenameResult } from '../src/lib/lsp-client';
import type { ModuleId } from '../src/lib/modules/detect';

type ToolArgs = Parameters<ToolDefinition['execute']>[0];

function mockCtx(dir: string): ToolContext {
  return {
    sessionID: 'test-session',
    messageID: 'test-message',
    agent: 'test-agent',
    directory: dir,
    worktree: dir,
    abort: new globalThis.AbortController().signal,
    metadata: () => ({}),
    ask: async () => {},
  };
}

async function execute(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string | { output: string }> {
  return tool.execute(args as unknown as ToolArgs, ctx);
}

function parse(result: string | { output: string }): Record<string, unknown> {
  const output = typeof result === 'string' ? result : result.output;
  return JSON.parse(output) as Record<string, unknown>;
}

function textEdit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string
): LspTextEdit {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

class FakeClient implements RenameClientLike {
  opened: string[] = [];

  constructor(
    private prepareResult: PrepareRenameResult | null,
    private renameResult: LspWorkspaceEdit | null,
    private renameError?: Error
  ) {}

  async openDocument(uri: string): Promise<void> {
    this.opened.push(uri);
  }

  async prepareRename(): Promise<PrepareRenameResult | null> {
    return this.prepareResult;
  }

  async rename(): Promise<LspWorkspaceEdit | null> {
    if (this.renameError) throw this.renameError;
    return this.renameResult;
  }
}

function makeRegistry(
  resolved: { client: RenameClientLike; languageId: string } | null,
  config: { command: string[]; installHint?: string; languageId: string } | null = null
): RenameRegistryLike {
  return {
    resolveServer: () => resolved,
    findConfig: () => config,
  };
}

function makeDir(name: string): string {
  const dir = join(
    tmpdir(),
    `supertools-rename-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PREPARE: PrepareRenameResult = {
  range: {
    start: { line: 2, character: 5 },
    end: { line: 2, character: 8 },
  },
  placeholder: 'Old',
};

function goRenameEdit(path: string): LspWorkspaceEdit {
  return { changes: { [pathToFileURL(path).href]: [textEdit(2, 5, 2, 8, 'New')] } };
}

describe('rename_symbol — PHP dispatch stays on tree-sitter', () => {
  it('returns the identical modified content as renameSymbol()', async () => {
    const filePath = resolve(import.meta.dir, 'fixtures', 'php', 'property.php');
    const tool = createRenameSymbolTool({ modules: ['php'] });
    const result = await execute(
      tool,
      { filePath, oldName: 'name', newName: 'title' },
      mockCtx(import.meta.dir)
    );
    const expected = await renameSymbol({ filePath, oldName: 'name', newName: 'title' });

    expect(typeof result).toBe('string');
    expect(result).toBe(expected.modifiedContent ?? '');
    expect(result as string).toContain('$title');
  });

  it('refuses .php when the php module is not active', async () => {
    const tool = createRenameSymbolTool({ modules: ['go'] });
    const result = parse(
      await execute(
        tool,
        { filePath: '/tmp/whatever.php', oldName: 'a', newName: 'b' },
        mockCtx('/tmp')
      )
    );

    expect(result.available).toBe(false);
    expect(String(result.error)).toContain("'php'");
  });
});

describe('rename_symbol — LSP module gating', () => {
  const cases: Array<{ ext: string; modules: string[]; required: string }> = [
    { ext: 'go', modules: ['typescript'], required: 'go' },
    { ext: 'rs', modules: ['go'], required: 'rust' },
    { ext: 'ts', modules: ['go'], required: 'typescript' },
    { ext: 'php', modules: ['go'], required: 'php' },
  ];

  for (const testCase of cases) {
    it(`refuses .${testCase.ext} when module '${testCase.required}' is inactive`, async () => {
      const registry: RenameRegistryLike = {
        resolveServer: () => {
          throw new Error('registry must not be consulted when the module is inactive');
        },
        findConfig: () => null,
      };
      const tool = createRenameSymbolTool({
        modules: testCase.modules as ModuleId[],
        registry,
      });
      const result = parse(
        await execute(
          tool,
          { filePath: `/tmp/whatever.${testCase.ext}`, oldName: 'a', newName: 'b' },
          mockCtx('/tmp')
        )
      );

      expect(result.available).toBe(false);
      expect(String(result.error)).toContain(`'${testCase.required}'`);
    });
  }
});

describe('rename_symbol — LSP dispatch', () => {
  it('returns a hint when no server is configured for the extension', async () => {
    const dir = makeDir('no-server');
    const file = join(dir, 'sample.xyz');
    writeFileSync(file, 'content\n', 'utf-8');
    const tool = createRenameSymbolTool({ modules: [], registry: makeRegistry(null, null) });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'content', newName: 'changed', line: 1 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(false);
      expect(String(result.hint)).toContain('No LSP server configured');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the missing language server when a config exists but is not installed', async () => {
    const dir = makeDir('not-installed');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n', 'utf-8');
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry(null, {
        command: ['gopls'],
        languageId: 'go',
        installHint: 'go install gopls',
      }),
    });

    try {
      const result = parse(
        await execute(tool, { filePath: file, oldName: 'a', newName: 'b' }, mockCtx(dir))
      );
      expect(result.available).toBe(false);
      expect(String(result.hint)).toContain('gopls');
      expect(result.suggestion).toBe('go install gopls');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports prepareRename null as "rename not possible at this position"', async () => {
    const dir = makeDir('prepare-null');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(null, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(false);
      expect(String(result.hint)).toContain('rename not possible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proceeds to rename when prepareRename returns defaultBehavior', async () => {
    const dir = makeDir('prepare-default');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient({ defaultBehavior: true }, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(true);
      expect(result.applied).toBe(true);
      expect(readFileSync(file, 'utf-8')).toContain('func New()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a rename failure into available:true with the error', async () => {
    const dir = makeDir('rename-error');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, null, new Error('rename blew up'));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(true);
      expect(String(result.error)).toContain('rename blew up');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a null rename result without throwing', async () => {
    const dir = makeDir('rename-null');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, null);
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(true);
      expect(String(result.error)).toContain('no changes');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the WorkspaceEdit and reports per-file summaries', async () => {
    const dir = makeDir('apply');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.totalEdits).toBe(1);
      expect((result.files as Array<Record<string, unknown>>)[0].path).toBe(file);
      expect(readFileSync(file, 'utf-8')).toContain('func New()');
      expect(readFileSync(file, 'utf-8')).not.toContain('func Old()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats preview as a dry run and writes nothing', async () => {
    const dir = makeDir('preview');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3, preview: true },
          mockCtx(dir)
        )
      );
      expect(result.available).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.totalEdits).toBe(1);
      expect((result.preview as unknown[]).length).toBe(1);
      expect(readFileSync(file, 'utf-8')).toContain('func Old()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats dry_run as a dry run as well', async () => {
    const dir = makeDir('dry-run');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3, dry_run: true },
          mockCtx(dir)
        )
      );
      expect(result.applied).toBe(false);
      expect(readFileSync(file, 'utf-8')).toContain('func Old()');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a hint when the symbol cannot be located', async () => {
    const dir = makeDir('not-found');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(tool, { filePath: file, oldName: 'Missing', newName: 'New' }, mockCtx(dir))
      );
      expect(result.available).toBe(false);
      expect(String(result.hint)).toContain("'Missing' not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the column from oldName when only a line is given', async () => {
    const dir = makeDir('line-only');
    const file = join(dir, 'main.go');
    writeFileSync(file, 'package main\n\nfunc Old() {}\n', 'utf-8');
    const client = new FakeClient(PREPARE, goRenameEdit(file));
    const tool = createRenameSymbolTool({
      modules: ['go'],
      registry: makeRegistry({ client, languageId: 'go' }),
    });

    try {
      const result = parse(
        await execute(
          tool,
          { filePath: file, oldName: 'Old', newName: 'New', line: 3 },
          mockCtx(dir)
        )
      );
      expect(result.applied).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-file WorkspaceEdit coverage with a fake server. This compensates
// for the live checks below being skipped when a server is unavailable.
// ────────────────────────────────────────────────────────────────

interface CrossFileSpec {
  name: string;
  modules: ModuleId[];
  files: Array<{ path: string; content: string }>;
}

const CROSS_FILE_CASES: CrossFileSpec[] = [
  {
    name: 'typescript',
    modules: ['typescript'],
    files: [
      { path: 'a.ts', content: "export function foo(): string { return 'x'; }\n" },
      { path: 'b.ts', content: "import { foo } from './a';\nexport const y = foo();\n" },
    ],
  },
  {
    name: 'go',
    modules: ['go'],
    files: [
      { path: 'a/a.go', content: 'package a\n\nfunc foo() string { return "x" }\n' },
      { path: 'b/b.go', content: 'package b\n\nfunc Call() string { return foo() }\n' },
    ],
  },
  {
    name: 'rust',
    modules: ['rust'],
    files: [
      { path: 'src/a.rs', content: 'pub fn foo() -> String { String::from("x") }\n' },
      { path: 'src/b.rs', content: 'use crate::a::foo;\n\npub fn call() -> String { foo() }\n' },
    ],
  },
];

function writeCrossFileCase(
  dir: string,
  spec: CrossFileSpec
): Array<{ path: string; content: string }> {
  return spec.files.map((file) => {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, 'utf-8');
    return { path, content: file.content };
  });
}

function crossFileEdit(
  written: Array<{ path: string; content: string }>,
  oldName: string,
  newName: string
): LspWorkspaceEdit {
  const changes: Record<string, LspTextEdit[]> = {};
  for (const file of written) {
    const edits: LspTextEdit[] = [];
    let index = file.content.indexOf(oldName);
    while (index >= 0) {
      const before = file.content[index - 1] ?? '';
      const after = file.content[index + oldName.length] ?? '';
      const isWord = !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
      if (isWord) {
        const prefix = file.content.slice(0, index);
        const line = prefix.split('\n').length - 1;
        const character = index - (prefix.lastIndexOf('\n') + 1);
        edits.push(textEdit(line, character, line, character + oldName.length, newName));
      }
      index = file.content.indexOf(oldName, index + oldName.length);
    }
    changes[pathToFileURL(file.path).href] = edits;
  }
  return { changes };
}

describe('rename_symbol — cross-file WorkspaceEdit (fake server)', () => {
  for (const spec of CROSS_FILE_CASES) {
    it(`applies a two-file rename for ${spec.name}`, async () => {
      const dir = makeDir(`cross-${spec.name}`);
      try {
        const written = writeCrossFileCase(dir, spec);
        const client = new FakeClient(PREPARE, crossFileEdit(written, 'foo', 'bar'));
        const tool = createRenameSymbolTool({
          modules: spec.modules,
          registry: makeRegistry({ client, languageId: spec.name }),
        });
        const result = parse(
          await execute(
            tool,
            { filePath: written[0].path, oldName: 'foo', newName: 'bar' },
            mockCtx(dir)
          )
        );

        expect(result.available).toBe(true);
        expect(result.applied).toBe(true);
        const summarized = (result.files as Array<{ path: string }>).map((file) => file.path);
        expect(summarized.sort()).toEqual(written.map((file) => file.path).sort());
        for (const file of written) {
          const content = readFileSync(file.path, 'utf-8');
          expect(content).toContain('bar');
          expect(content).not.toContain('foo');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`writes nothing for ${spec.name} when dry_run is true`, async () => {
      const dir = makeDir(`cross-dry-${spec.name}`);
      try {
        const written = writeCrossFileCase(dir, spec);
        const client = new FakeClient(PREPARE, crossFileEdit(written, 'foo', 'bar'));
        const tool = createRenameSymbolTool({
          modules: spec.modules,
          registry: makeRegistry({ client, languageId: spec.name }),
        });
        const result = parse(
          await execute(
            tool,
            { filePath: written[0].path, oldName: 'foo', newName: 'bar', dry_run: true },
            mockCtx(dir)
          )
        );

        expect(result.available).toBe(true);
        expect(result.applied).toBe(false);
        expect((result.preview as unknown[]).length).toBeGreaterThanOrEqual(2);
        for (const file of written) {
          expect(readFileSync(file.path, 'utf-8')).toBe(file.content);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

// ────────────────────────────────────────────────────────────────
// Live checks — skipped when the language server is not installed.
// Fixtures are copied to a temp dir so the repo is never mutated.
// ────────────────────────────────────────────────────────────────

function hasBinary(name: string): boolean {
  try {
    const located = Bun.spawnSync(['which', name], { stdout: 'pipe', stderr: 'pipe' });
    if (located.exitCode !== 0) return false;
    // A rustup shim can exist while the component is missing; only run when
    // the binary actually answers (`gopls version`, everything else `--version`).
    for (const flag of [['--version'], ['version']]) {
      const probe = Bun.spawnSync([name, ...flag], { stdout: 'pipe', stderr: 'pipe' });
      if (probe.exitCode === 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function copyFixture(name: string): string {
  const source = resolve(import.meta.dir, 'fixtures', 'lsp-rename', name);
  const target = join(
    tmpdir(),
    `supertools-live-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  cpSync(source, target, { recursive: true });
  return target;
}

async function cleanupLive(dir: string): Promise<void> {
  await getLspRegistry().shutdownAll();
  resetLspRegistry();
  rmSync(dir, { recursive: true, force: true });
}

describe('rename_symbol — live LSP checks', () => {
  it.skipIf(!hasBinary('gopls'))(
    'renames a Go function used from another package',
    async () => {
      resetLspRegistry();
      const dir = copyFixture('go');
      const tool = createRenameSymbolTool({ modules: ['core', 'search', 'lsp', 'go'] });
      try {
        const file = join(dir, 'greet', 'greet.go');
        const result = parse(
          await execute(
            tool,
            { filePath: file, oldName: 'Hello', newName: 'Hail', line: 3, column: 6 },
            mockCtx(dir)
          )
        );
        expect(typeof result.available).toBe('boolean');
        if (!result.applied) {
          expect(result.hint ?? result.error).toBeDefined();
        } else {
          expect(readFileSync(file, 'utf-8')).toContain('Hail');
          expect(readFileSync(join(dir, 'use', 'use.go'), 'utf-8')).toContain('Hail');
        }
      } finally {
        await cleanupLive(dir);
      }
    },
    60000
  );

  it.skipIf(!hasBinary('rust-analyzer'))(
    'renames a Rust function used from another module',
    async () => {
      resetLspRegistry();
      const dir = copyFixture('rust');
      const tool = createRenameSymbolTool({ modules: ['core', 'search', 'lsp', 'rust'] });
      try {
        const file = join(dir, 'src', 'greet.rs');
        const result = parse(
          await execute(
            tool,
            { filePath: file, oldName: 'Hello', newName: 'Hail', line: 3, column: 8 },
            mockCtx(dir)
          )
        );
        expect(typeof result.available).toBe('boolean');
        if (!result.applied) {
          expect(result.hint ?? result.error).toBeDefined();
        } else {
          expect(readFileSync(file, 'utf-8')).toContain('Hail');
          expect(readFileSync(join(dir, 'src', 'use_it.rs'), 'utf-8')).toContain('Hail');
        }
      } finally {
        await cleanupLive(dir);
      }
    },
    60000
  );

  it.skipIf(!hasBinary('typescript-language-server'))(
    'renames a TypeScript export used in another file',
    async () => {
      resetLspRegistry();
      const dir = copyFixture('typescript');
      const tool = createRenameSymbolTool({ modules: ['core', 'search', 'lsp', 'typescript'] });
      try {
        const file = join(dir, 'src', 'lib.ts');
        const result = parse(
          await execute(
            tool,
            { filePath: file, oldName: 'greet', newName: 'hail', line: 1, column: 17 },
            mockCtx(dir)
          )
        );
        expect(typeof result.available).toBe('boolean');
        if (!result.applied) {
          expect(result.hint ?? result.error).toBeDefined();
        } else {
          expect(readFileSync(file, 'utf-8')).toContain('hail');
          expect(readFileSync(join(dir, 'src', 'use.ts'), 'utf-8')).toContain('hail');
        }
      } finally {
        await cleanupLive(dir);
      }
    },
    60000
  );
});
