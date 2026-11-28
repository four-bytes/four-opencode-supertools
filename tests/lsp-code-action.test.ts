// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolContext, ToolDefinition } from '@opencode-ai/plugin';
import {
  createLspCodeActionTool,
  type CodeActionClientLike,
  type CodeActionRegistryLike,
} from '../src/tools/lsp-code-action';
import type {
  LspCodeAction,
  LspCodeActionContext,
  LspRange,
  LspTextEdit,
  LspWorkspaceEdit,
} from '../src/lib/lsp-client';

type ExecResult = Awaited<ReturnType<ToolDefinition['execute']>>;

let dir = '';
let filePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'supertools-code-action-'));
  filePath = join(dir, 'sample.ts');
  writeFileSync(filePath, 'const a = 1;\nconst b = 2;\n', 'utf-8');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mockCtx(): ToolContext {
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

function output(result: ExecResult): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'output' in result) return result.output;
  throw new Error('unexpected tool result');
}

function parse(result: ExecResult): Record<string, unknown> {
  return JSON.parse(output(result)) as Record<string, unknown>;
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

function insertEdit(newText: string): LspWorkspaceEdit {
  const uri = pathToFileURL(filePath).href;
  return { changes: { [uri]: [textEdit(0, 0, 0, 0, newText)] } };
}

class FakeClient implements CodeActionClientLike {
  opened: string[] = [];
  contexts: LspCodeActionContext[] = [];
  resolveResult: LspCodeAction | null = null;
  executed: { command: string; args?: unknown[] } | null = null;
  private drained: LspWorkspaceEdit[] = [];

  constructor(
    private actions: LspCodeAction[],
    private commandEdits: LspWorkspaceEdit[] = []
  ) {}

  async openDocument(uri: string): Promise<void> {
    this.opened.push(uri);
  }

  async codeAction(
    _uri: string,
    _range: LspRange,
    context?: LspCodeActionContext
  ): Promise<LspCodeAction[]> {
    this.contexts.push(context ?? {});
    return this.actions;
  }

  async resolveCodeAction(): Promise<LspCodeAction | null> {
    return this.resolveResult;
  }

  async executeCommand(command: string, args?: unknown[]): Promise<unknown> {
    this.executed = { command, ...(args ? { args } : {}) };
    this.drained = this.commandEdits;
    return null;
  }

  drainApplyEdits(): LspWorkspaceEdit[] {
    const edits = this.drained;
    this.drained = [];
    return edits;
  }
}

function resolvedRegistry(client: CodeActionClientLike): CodeActionRegistryLike {
  return {
    resolveServer: () => ({ client, languageId: 'typescript' }),
    findConfig: () => null,
  };
}

function missingRegistry(withConfig: boolean): CodeActionRegistryLike {
  return {
    resolveServer: () => null,
    findConfig: () =>
      withConfig
        ? {
            command: ['typescript-language-server', '--stdio'],
            installHint: 'npm i -g typescript-language-server',
            languageId: 'typescript',
          }
        : null,
  };
}

function toolFor(client: CodeActionClientLike): ToolDefinition {
  return createLspCodeActionTool({ registry: resolvedRegistry(client) });
}

async function execute(tool: ToolDefinition, args: Record<string, unknown>): Promise<ExecResult> {
  return tool.execute(args as never, mockCtx());
}

describe('lsp_code_action — list mode', () => {
  it('renders one compact line per action', async () => {
    const client = new FakeClient([
      { title: 'Extract function', kind: 'refactor.extract.function' },
      { title: 'Stub methods for interface Foo', kind: 'quickfix' },
    ]);

    const text = output(await execute(toolFor(client), { filePath, line: 1 }));
    const lines = text.split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('available actions: 2');
    expect(lines[1]).toContain('[0] refactor.extract.function');
    expect(lines[1]).toContain('Extract function');
    expect(lines[2]).toContain('[1] quickfix');
  });

  it('reports an empty result', async () => {
    const text = output(await execute(toolFor(new FakeClient([])), { filePath }));
    expect(text).toContain('No code actions available');
  });

  it('opens the document before asking for actions', async () => {
    const client = new FakeClient([]);
    await execute(toolFor(client), { filePath });
    expect(client.opened).toEqual([pathToFileURL(filePath).href]);
  });

  it('sends an empty diagnostics context by default', async () => {
    const client = new FakeClient([]);
    await execute(toolFor(client), { filePath, line: 1 });
    expect(client.contexts).toHaveLength(1);
    expect(client.contexts[0].diagnostics).toEqual([]);
  });
});

describe('lsp_code_action — apply mode', () => {
  it('applies an action selected by exact kind', async () => {
    const client = new FakeClient([
      {
        title: 'Extract function',
        kind: 'refactor.extract.function',
        edit: insertEdit('// header\n'),
      },
    ]);

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'refactor.extract.function',
        line: 1,
      })
    );

    expect(payload.applied).toBe(true);
    expect(payload.totalEdits).toBe(1);
    expect(readFileSync(filePath, 'utf-8').startsWith('// header\n')).toBe(true);
  });

  it('applies an action selected by index', async () => {
    const client = new FakeClient([
      { title: 'Unrelated', kind: 'quickfix' },
      { title: 'Extract function', kind: 'refactor.extract.function', edit: insertEdit('// x\n') },
    ]);

    const payload = parse(await execute(toolFor(client), { filePath, mode: 'apply', index: 1 }));

    expect(payload.applied).toBe(true);
    expect(readFileSync(filePath, 'utf-8').startsWith('// x\n')).toBe(true);
  });

  it('does not write on dryRun and returns a preview', async () => {
    const before = readFileSync(filePath, 'utf-8');
    const client = new FakeClient([
      {
        title: 'Extract function',
        kind: 'refactor.extract.function',
        edit: insertEdit('// header\n'),
      },
    ]);

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'refactor.extract.function',
        dryRun: true,
      })
    );

    expect(payload.dryRun).toBe(true);
    expect(payload.applied).toBe(false);
    expect(Array.isArray(payload.preview)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('resolves a deferred action before applying its edit', async () => {
    const client = new FakeClient([
      { title: 'Organize imports', kind: 'source.organizeImports', data: { id: 7 } },
    ]);
    client.resolveResult = {
      title: 'Organize imports',
      kind: 'source.organizeImports',
      edit: insertEdit('// organized\n'),
    };

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'source.organizeImports',
      })
    );

    expect(payload.applied).toBe(true);
    expect(readFileSync(filePath, 'utf-8').startsWith('// organized\n')).toBe(true);
    expect(client.executed).toBeNull();
  });

  it('executes a command-only action and applies the server-sent edit', async () => {
    const client = new FakeClient(
      [
        {
          title: 'Apply source change',
          kind: 'quickfix',
          command: {
            title: 'Apply source change',
            command: 'rust-analyzer.applySourceChange',
            arguments: [{ id: 1 }],
          },
        },
      ],
      [insertEdit('// from-command\n')]
    );

    const payload = parse(
      await execute(toolFor(client), { filePath, mode: 'apply', kind: 'quickfix' })
    );

    expect(payload.commandExecuted).toBe(true);
    expect(payload.applied).toBe(true);
    expect(client.executed?.command).toBe('rust-analyzer.applySourceChange');
    expect(readFileSync(filePath, 'utf-8').startsWith('// from-command\n')).toBe(true);
  });

  it('does not execute commands on dryRun', async () => {
    const client = new FakeClient(
      [
        {
          title: 'Apply source change',
          kind: 'quickfix',
          command: { title: 'Apply source change', command: 'rust-analyzer.applySourceChange' },
        },
      ],
      [insertEdit('// from-command\n')]
    );

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'quickfix',
        dryRun: true,
      })
    );

    expect(payload.wouldExecuteCommand).toBe(true);
    expect(payload.applied).toBe(false);
    expect(client.executed).toBeNull();
  });

  it('lists available actions when the kind is unknown and changes nothing', async () => {
    const before = readFileSync(filePath, 'utf-8');
    const client = new FakeClient([
      { title: 'Extract function', kind: 'refactor.extract.function', edit: insertEdit('// x\n') },
      { title: 'Quick fix', kind: 'quickfix' },
    ]);

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'refactor.inline',
      })
    );

    expect(payload.applied).toBe(false);
    expect(String(payload.error)).toContain('no action with kind');
    expect((payload.availableActions as unknown[]).length).toBe(2);
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });

  it('rejects an ambiguous kind', async () => {
    const client = new FakeClient([
      { title: 'One', kind: 'quickfix' },
      { title: 'Two', kind: 'quickfix' },
    ]);

    const payload = parse(
      await execute(toolFor(client), { filePath, mode: 'apply', kind: 'quickfix' })
    );

    expect(payload.applied).toBe(false);
    expect(String(payload.error)).toContain('matches 2 actions');
  });

  it('requires a selector', async () => {
    const client = new FakeClient([{ title: 'One', kind: 'quickfix' }]);

    const payload = parse(await execute(toolFor(client), { filePath, mode: 'apply' }));

    expect(String(payload.error)).toContain('pass index, title or kind');
  });

  it('refuses a disabled action', async () => {
    const client = new FakeClient([
      {
        title: 'Extract function',
        kind: 'refactor.extract.function',
        disabled: { reason: 'not available in this context' },
      },
    ]);

    const payload = parse(
      await execute(toolFor(client), {
        filePath,
        mode: 'apply',
        kind: 'refactor.extract.function',
      })
    );

    expect(payload.applied).toBe(false);
    expect(String(payload.error)).toContain('disabled');
  });
});

describe('lsp_code_action — availability and ranges', () => {
  it('reports a missing server config', async () => {
    const tool = createLspCodeActionTool({ registry: missingRegistry(false) });
    const payload = parse(await execute(tool, { filePath }));

    expect(payload.available).toBe(false);
    expect(String(payload.hint)).toContain('No LSP server configured');
  });

  it('reports an uninstalled server with an install hint', async () => {
    const tool = createLspCodeActionTool({ registry: missingRegistry(true) });
    const payload = parse(await execute(tool, { filePath }));

    expect(payload.available).toBe(false);
    expect(String(payload.hint)).toContain('is not installed');
    expect(String(payload.suggestion)).toContain('typescript-language-server');
  });

  it('rejects a line outside the file', async () => {
    const payload = parse(await execute(toolFor(new FakeClient([])), { filePath, line: 999 }));

    expect(payload.available).toBe(false);
    expect(String(payload.hint)).toContain('outside the file');
  });

  it('reports an unreadable file', async () => {
    const payload = parse(
      await execute(toolFor(new FakeClient([])), { filePath: join(dir, 'missing.ts') })
    );

    expect(payload.available).toBe(false);
    expect(String(payload.hint)).toContain('Could not read file');
  });
});
