// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * WorkspaceEdit applier — turns an LSP `WorkspaceEdit` into an atomic,
 * all-or-nothing write set. Reads and snapshots every touched file first, then
 * writes; any failure restores every already-written file byte-identically.
 */

import { readFile as readFilePromise, writeFile as writeFilePromise } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LspTextEdit, LspWorkspaceEdit } from './lsp-client';

export interface FileChangeSummary {
  path: string;
  edits: number;
  added: number;
  removed: number;
}

export interface WorkspaceEditPreview {
  path: string;
  line: number;
  before: string;
  after: string;
}

export interface ApplyWorkspaceEditResult {
  applied: boolean;
  files: FileChangeSummary[];
  totalEdits: number;
  preview?: WorkspaceEditPreview[];
  /**
   * Present on failures. `true` when every already-written file was restored;
   * `false` when at least one restore failed — `error` then names the affected
   * path(s) alongside the original failure.
   */
  rolledBack?: boolean;
  error?: string;
}

export interface ApplyWorkspaceEditOptions {
  dryRun?: boolean;
  previewLimit?: number;
  writeFile?: (path: string, content: string) => Promise<void>;
}

interface TextDocumentEditLike {
  textDocument?: { uri?: string };
  edits?: LspTextEdit[];
}

interface FileOperationLike {
  kind?: string;
}

const DEFAULT_PREVIEW_LIMIT = 20;

function uriToPath(uri: string): string {
  if (!uri.startsWith('file:')) {
    throw new Error(`Unsupported URI (only file: URIs are supported): ${uri}`);
  }
  try {
    return fileURLToPath(uri);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid file URI "${uri}": ${reason}`, { cause: err });
  }
}

function isTextDocumentEdit(entry: unknown): entry is TextDocumentEditLike {
  return (
    !!entry &&
    typeof entry === 'object' &&
    'textDocument' in entry &&
    'edits' in entry &&
    Array.isArray((entry as TextDocumentEditLike).edits)
  );
}

/**
 * Normalise a WorkspaceEdit to file path → edits. Throws for non-`file:` URIs
 * and file-operation documentChanges (`create`/`rename`/`delete`), because a
 * partial application would be worse than a clear rejection.
 */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const result = new Map<string, LspTextEdit[]>();

  const add = (uri: string, edits: LspTextEdit[]): void => {
    const path = uriToPath(uri);
    const existing = result.get(path);
    if (existing) existing.push(...edits);
    else result.set(path, [...edits]);
  };

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      add(uri, edits ?? []);
    }
  }

  if (edit.documentChanges) {
    for (const entry of edit.documentChanges) {
      if (isTextDocumentEdit(entry)) {
        const uri = entry.textDocument?.uri;
        if (!uri) throw new Error('TextDocumentEdit without a textDocument.uri');
        add(uri, entry.edits ?? []);
        continue;
      }

      const kind = (entry as FileOperationLike).kind ?? 'unknown';
      throw new Error(
        `Unsupported documentChange "${kind}": file operations are not supported, refusing to apply a partial edit`
      );
    }
  }

  return result;
}

/** Line-start offsets in UTF-16 code units (matches LSP `character`). */
function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function positionToOffset(
  content: string,
  offsets: number[],
  line: number,
  character: number
): number {
  if (!Number.isInteger(line) || line < 0 || line >= offsets.length) {
    throw new Error(`Position line ${line} is outside the file (${offsets.length} lines)`);
  }
  if (!Number.isInteger(character) || character < 0) {
    throw new Error(`Position character ${character} is invalid`);
  }
  const offset = offsets[line] + character;
  if (offset > content.length) {
    throw new Error(`Position ${line}:${character} is outside the file`);
  }
  return offset;
}

interface ResolvedEdit {
  start: number;
  end: number;
  newText: string;
  line: number;
  before: string;
  after: string;
}

function resolveEdits(content: string, edits: LspTextEdit[]): ResolvedEdit[] {
  const offsets = lineStartOffsets(content);
  return edits.map((edit) => {
    const start = positionToOffset(
      content,
      offsets,
      edit.range.start.line,
      edit.range.start.character
    );
    const end = positionToOffset(content, offsets, edit.range.end.line, edit.range.end.character);
    if (end < start) {
      throw new Error(
        `Edit range ends before it starts at ${edit.range.start.line}:${edit.range.start.character}`
      );
    }
    return {
      start,
      end,
      newText: edit.newText,
      line: edit.range.start.line + 1,
      before: content.slice(start, end),
      after: edit.newText,
    };
  });
}

function assertNoOverlaps(edits: ResolvedEdit[]): void {
  const ascending = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ascending.length; index++) {
    if (ascending[index].start < ascending[index - 1].end) {
      throw new Error(
        `Overlapping edits in one file at offset ${ascending[index].start} (${ascending[index].line})`
      );
    }
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function summarize(
  path: string,
  oldContent: string,
  newContent: string,
  editCount: number
): FileChangeSummary {
  const oldLines = countLines(oldContent);
  const newLines = countLines(newContent);
  return {
    path,
    edits: editCount,
    added: Math.max(0, newLines - oldLines),
    removed: Math.max(0, oldLines - newLines),
  };
}

function applyEditsToContent(content: string, edits: ResolvedEdit[]): string {
  // Bottom-up so earlier offsets stay valid.
  const descending = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = content;
  for (const edit of descending) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
  }
  return result;
}

function truncate(text: string, limit = 120): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

export async function applyWorkspaceEdit(
  edit: LspWorkspaceEdit,
  opts: ApplyWorkspaceEditOptions = {}
): Promise<ApplyWorkspaceEditResult> {
  const previewLimit = opts.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const writeFile =
    opts.writeFile ?? ((path: string, content: string) => writeFilePromise(path, content, 'utf-8'));

  let normalized: Map<string, LspTextEdit[]>;
  try {
    normalized = normalizeWorkspaceEdit(edit);
  } catch (err) {
    return {
      applied: false,
      files: [],
      totalEdits: 0,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (normalized.size === 0) {
    return {
      applied: false,
      files: [],
      totalEdits: 0,
      error: 'Workspace edit contains no changes',
    };
  }

  const snapshots: Array<{
    path: string;
    original: string;
    updated: string;
    edits: ResolvedEdit[];
  }> = [];
  const files: FileChangeSummary[] = [];
  const preview: WorkspaceEditPreview[] = [];
  let totalEdits = 0;

  // Phase 1: read and compute everything before touching the disk.
  try {
    for (const [path, edits] of normalized) {
      const original = await readFilePromise(path, 'utf-8');
      const resolved = resolveEdits(original, edits);
      assertNoOverlaps(resolved);
      const updated = applyEditsToContent(original, resolved);
      snapshots.push({ path, original, updated, edits: resolved });
      files.push(summarize(path, original, updated, resolved.length));
      totalEdits += resolved.length;

      for (const resolvedEdit of resolved) {
        if (preview.length >= previewLimit) break;
        preview.push({
          path,
          line: resolvedEdit.line,
          before: truncate(resolvedEdit.before),
          after: truncate(resolvedEdit.after),
        });
      }
    }
  } catch (err) {
    return {
      applied: false,
      files: [],
      totalEdits: 0,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (opts.dryRun) {
    return { applied: false, files, totalEdits, preview };
  }

  // Phase 2: write. On any failure, restore everything written so far.
  const written: Array<{ path: string; original: string }> = [];
  try {
    for (const snapshot of snapshots) {
      await writeFile(snapshot.path, snapshot.updated);
      written.push({ path: snapshot.path, original: snapshot.original });
    }
  } catch (err) {
    const originalError = err instanceof Error ? err.message : String(err);
    const restoreFailures: string[] = [];
    for (const entry of written) {
      try {
        await writeFile(entry.path, entry.original);
      } catch (restoreErr) {
        const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        restoreFailures.push(`${entry.path} (${reason})`);
      }
    }

    if (restoreFailures.length > 0) {
      return {
        applied: false,
        files,
        totalEdits,
        rolledBack: false,
        error: `Restore failed for ${restoreFailures.join(', ')}; original failure: ${originalError}`,
      };
    }

    return { applied: false, files, totalEdits, rolledBack: true, error: originalError };
  }

  return { applied: true, files, totalEdits, preview };
}
