// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  applyWorkspaceEdit,
  normalizeWorkspaceEdit,
  type ApplyWorkspaceEditOptions,
} from '../src/lib/workspace-edit';
import type { LspTextEdit, LspWorkspaceEdit } from '../src/lib/lsp-client';

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

describe('workspace-edit', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `supertools-workspace-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* test cleanup */
    }
  });

  function write(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  function uri(path: string): string {
    return pathToFileURL(path).href;
  }

  it('applies two edits on one line bottom-up without corrupting offsets', async () => {
    const path = write('one-line.txt', 'abcabc\n');
    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(path)]: [textEdit(0, 0, 0, 3, 'X'), textEdit(0, 3, 0, 6, 'Y')],
      },
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(true);
    expect(result.totalEdits).toBe(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].edits).toBe(2);
    expect(readFileSync(path, 'utf-8')).toBe('XY\n');
  });

  it('applies edits across multiple files', async () => {
    const first = write('first.txt', 'foo\n');
    const second = write('second.txt', 'bar\n');
    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(first)]: [textEdit(0, 0, 0, 3, 'FOO')],
        [uri(second)]: [textEdit(0, 0, 0, 3, 'BAR')],
      },
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(true);
    expect(result.totalEdits).toBe(2);
    expect(result.files.map((file) => file.path).sort()).toEqual([first, second].sort());
    expect(readFileSync(first, 'utf-8')).toBe('FOO\n');
    expect(readFileSync(second, 'utf-8')).toBe('BAR\n');
  });

  it('applies a documentChanges TextDocumentEdit', async () => {
    const path = write('doc-changes.txt', 'hello world\n');
    const edit: LspWorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: uri(path), version: 1 },
          edits: [textEdit(0, 6, 0, 11, 'there')],
        },
      ],
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('hello there\n');
  });

  it('uses UTF-16 code-unit offsets (matching LSP) for astral characters', async () => {
    const path = write('utf16.txt', '😀Old\n');
    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(path)]: [textEdit(0, 2, 0, 5, 'New')],
      },
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('😀New\n');
  });

  it('dryRun writes nothing and returns a compact preview', async () => {
    const path = write('dry-run.txt', 'foo\n');
    let writes = 0;
    const writeFile = async (): Promise<void> => {
      writes++;
    };

    const result = await applyWorkspaceEdit(
      { changes: { [uri(path)]: [textEdit(0, 0, 0, 3, 'bar')] } },
      { dryRun: true, writeFile }
    );

    expect(result.applied).toBe(false);
    expect(result.totalEdits).toBe(1);
    expect(writes).toBe(0);
    expect(result.preview).toHaveLength(1);
    expect(result.preview?.[0].before).toBe('foo');
    expect(result.preview?.[0].after).toBe('bar');
    expect(readFileSync(path, 'utf-8')).toBe('foo\n');
  });

  it('rejects overlapping edits before writing anything', async () => {
    const path = write('overlap.txt', 'abcdef\n');
    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(path)]: [textEdit(0, 0, 0, 4, 'XX'), textEdit(0, 2, 0, 6, 'YY')],
      },
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('Overlapping');
    expect(readFileSync(path, 'utf-8')).toBe('abcdef\n');
  });

  it('fails atomically when a touched file cannot be read', async () => {
    const existing = write('exists.txt', 'keep\n');
    const missing = join(dir, 'missing.txt');

    const result = await applyWorkspaceEdit({
      changes: {
        [uri(existing)]: [textEdit(0, 0, 0, 4, 'EDIT')],
        [uri(missing)]: [textEdit(0, 0, 0, 1, 'X')],
      },
    });

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(readFileSync(existing, 'utf-8')).toBe('keep\n');
  });

  it('rolls back all files when a mid-apply write fails', async () => {
    const first = write('first.txt', 'AAA\n');
    const second = write('second.txt', 'BBB\n');
    const originalFirst = readFileSync(first, 'utf-8');
    const originalSecond = readFileSync(second, 'utf-8');
    const attempts = new Map<string, number>();

    const writeFile = async (path: string, content: string): Promise<void> => {
      const count = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, count);
      if (path === second && count === 1) {
        throw new Error('injected write failure');
      }
      writeFileSync(path, content, 'utf-8');
    };

    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(first)]: [textEdit(0, 0, 0, 3, 'XXX')],
        [uri(second)]: [textEdit(0, 0, 0, 3, 'YYY')],
      },
    };

    const result = await applyWorkspaceEdit(edit, { writeFile });

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('injected write failure');
    expect(readFileSync(first, 'utf-8')).toBe(originalFirst);
    expect(readFileSync(second, 'utf-8')).toBe(originalSecond);
  });

  it('reports rolledBack:false and names the file when a restore also fails', async () => {
    const first = write('first.txt', 'AAA\n');
    const second = write('second.txt', 'BBB\n');
    const attempts = new Map<string, number>();

    const writeFile = async (path: string, content: string): Promise<void> => {
      const count = (attempts.get(path) ?? 0) + 1;
      attempts.set(path, count);
      if (path === second && count === 1) {
        throw new Error('injected write failure');
      }
      if (path === first && count === 2) {
        throw new Error('injected restore failure');
      }
      writeFileSync(path, content, 'utf-8');
    };

    const result = await applyWorkspaceEdit(
      {
        changes: {
          [uri(first)]: [textEdit(0, 0, 0, 3, 'XXX')],
          [uri(second)]: [textEdit(0, 0, 0, 3, 'YYY')],
        },
      },
      { writeFile }
    );

    expect(result.applied).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toContain(first);
    expect(result.error).toContain('injected write failure');
  });

  it('computes added/removed line counts from old vs new content', async () => {
    const path = write('lines.txt', 'a\nb\n');
    const edit: LspWorkspaceEdit = {
      changes: {
        [uri(path)]: [textEdit(0, 0, 2, 0, 'a\nb\nc\n')],
      },
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(true);
    expect(result.files[0].added).toBe(1);
    expect(result.files[0].removed).toBe(0);
  });

  it('rejects a non-file URI instead of silently skipping it', async () => {
    const edit: LspWorkspaceEdit = {
      changes: { 'untitled:Untitled-1': [textEdit(0, 0, 0, 1, 'x')] },
    };

    expect(() => normalizeWorkspaceEdit(edit)).toThrow(/file:/);
    const result = await applyWorkspaceEdit(edit);
    expect(result.applied).toBe(false);
    expect(result.error).toContain('file:');
  });

  it('rejects file-operation documentChanges naming the operation', async () => {
    const edit: LspWorkspaceEdit = {
      documentChanges: [{ kind: 'create', uri: uri(join(dir, 'new.txt')) }],
    };

    const result = await applyWorkspaceEdit(edit);

    expect(result.applied).toBe(false);
    expect(result.error).toContain('create');
    expect(result.rolledBack).toBe(true);
  });

  it('returns an error for an edit without changes', async () => {
    const result = await applyWorkspaceEdit({});
    expect(result.applied).toBe(false);
    expect(result.error).toContain('no changes');
  });

  it('uses an injected writeFile for successful applies', async () => {
    const path = write('injected.txt', 'one\n');
    const writes: Array<{ path: string; content: string }> = [];
    const writeFile: ApplyWorkspaceEditOptions['writeFile'] = async (target, content) => {
      writes.push({ path: target, content });
      writeFileSync(target, content, 'utf-8');
    };

    const result = await applyWorkspaceEdit(
      { changes: { [uri(path)]: [textEdit(0, 0, 0, 3, 'two')] } },
      { writeFile }
    );

    expect(result.applied).toBe(true);
    expect(writes).toEqual([{ path, content: 'two\n' }]);
  });
});
