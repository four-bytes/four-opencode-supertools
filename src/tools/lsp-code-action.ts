// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * `lsp_code_action` — list and apply language-server code actions.
 *
 * Language-agnostic: whatever the registered LSP server offers for the range
 * (Go "extract function"/"stub methods", Rust "fill match arms", TypeScript
 * "extract function"/"organize imports", quick fixes, ...). The returned
 * WorkspaceEdit is applied through the atomic applier from #85.
 */

import { readFile as readFilePromise } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tool } from '@opencode-ai/plugin';
import type { ToolDefinition, ToolResult } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import type {
  LspCodeAction,
  LspCodeActionContext,
  LspRange,
  LspWorkspaceEdit,
} from '../lib/lsp-client';
import { getLspRegistry } from '../lib/lsp-registry';
import { applyWorkspaceEdit } from '../lib/workspace-edit';
import type { FileChangeSummary, WorkspaceEditPreview } from '../lib/workspace-edit';

const z = tool.schema;

export interface CodeActionClientLike {
  openDocument(uri: string, text: string, languageId: string): Promise<void>;
  codeAction(
    uri: string,
    range: LspRange,
    context?: LspCodeActionContext,
    timeout?: number
  ): Promise<LspCodeAction[]>;
  resolveCodeAction?(action: LspCodeAction, timeout?: number): Promise<LspCodeAction | null>;
  executeCommand?(command: string, args?: unknown[], timeout?: number): Promise<unknown>;
  drainApplyEdits?(): LspWorkspaceEdit[];
}

export interface CodeActionRegistryLike {
  resolveServer(
    filePath: string,
    options?: { configRoot?: string }
  ): { client: CodeActionClientLike; languageId: string } | null;
  findConfig(
    filePath: string,
    configRoot?: string
  ): { command: string[]; installHint?: string; languageId: string } | null;
}

export interface CodeActionToolContext {
  /** Injection seam for tests; defaults to the shared LSP registry. */
  registry?: CodeActionRegistryLike;
}

interface CodeActionInput {
  filePath: string;
  mode?: 'list' | 'apply';
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  kind?: string;
  title?: string;
  index?: number;
  dryRun?: boolean;
}

interface AppliedSummary {
  applied: boolean;
  files: FileChangeSummary[];
  totalEdits: number;
  preview: WorkspaceEditPreview[];
  errors: string[];
  rolledBack: boolean;
}

function jsonResult(payload: Record<string, unknown>): ToolResult {
  return { title: 'LSP Code Action', output: JSON.stringify(payload, null, 2), metadata: {} };
}

function textResult(output: string): ToolResult {
  return { title: 'LSP Code Action', output, metadata: {} };
}

function formatRange(range: LspRange): string {
  return `${range.start.line + 1}:${range.start.character + 1}-${range.end.line + 1}:${
    range.end.character + 1
  }`;
}

/**
 * Resolve a 1-based user range to an LSP range. Without `line` the whole file
 * is used. Without `endLine` the selection ends at the end of the start line.
 */
function resolveRange(source: string, input: CodeActionInput): LspRange | { error: string } {
  const lines = source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  if (input.line === undefined) {
    if (
      input.column !== undefined ||
      input.endLine !== undefined ||
      input.endColumn !== undefined
    ) {
      return { error: 'line is required when column, endLine or endColumn is given' };
    }
    const last = lines.length - 1;
    return {
      start: { line: 0, character: 0 },
      end: { line: last, character: lines[last].length },
    };
  }

  if (!Number.isInteger(input.line) || input.line < 1 || input.line > lines.length) {
    return { error: `line ${input.line} is outside the file` };
  }
  const startLine = input.line - 1;
  const column = input.column ?? 1;
  if (!Number.isInteger(column) || column < 1 || column > lines[startLine].length + 1) {
    return { error: `column ${column} is outside line ${input.line}` };
  }
  const startChar = column - 1;

  const endLineNumber = input.endLine ?? input.line;
  if (
    !Number.isInteger(endLineNumber) ||
    endLineNumber < input.line ||
    endLineNumber > lines.length
  ) {
    return {
      error: `endLine ${endLineNumber} is invalid (must be >= line and inside the file)`,
    };
  }
  const endLine = endLineNumber - 1;

  let endChar: number;
  if (input.endColumn !== undefined) {
    if (
      !Number.isInteger(input.endColumn) ||
      input.endColumn < 1 ||
      input.endColumn > lines[endLine].length + 1
    ) {
      return { error: `endColumn ${input.endColumn} is outside line ${endLineNumber}` };
    }
    endChar = input.endColumn - 1;
  } else {
    endChar = lines[endLine].length;
  }

  if (endLine === startLine && endChar < startChar) {
    return { error: 'range end is before its start' };
  }

  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

interface ActionSelection {
  action: LspCodeAction;
  index: number;
}

function selectAction(
  actions: LspCodeAction[],
  input: CodeActionInput
): ActionSelection | { error: string } {
  if (input.index !== undefined) {
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= actions.length) {
      return { error: `index ${input.index} is out of range (0-${actions.length - 1})` };
    }
    return { action: actions[input.index], index: input.index };
  }

  if (input.title !== undefined) {
    const matches = actions
      .map((action, index) => ({ action, index }))
      .filter((entry) => entry.action.title === input.title);
    if (matches.length === 0) {
      return { error: `no action titled "${input.title}"` };
    }
    if (matches.length > 1) {
      return { error: `title "${input.title}" matches ${matches.length} actions; use index` };
    }
    return matches[0];
  }

  if (input.kind !== undefined) {
    const matches = actions
      .map((action, index) => ({ action, index }))
      .filter((entry) => entry.action.kind === input.kind);
    if (matches.length === 0) {
      return { error: `no action with kind "${input.kind}"` };
    }
    if (matches.length > 1) {
      return {
        error: `kind "${input.kind}" matches ${matches.length} actions; use title or index`,
      };
    }
    return matches[0];
  }

  return { error: 'pass index, title or kind to apply an action' };
}

function describeActions(actions: LspCodeAction[], filePath: string, range: LspRange): string {
  if (actions.length === 0) {
    return `No code actions available for ${filePath} (${formatRange(range)}).`;
  }
  const lines = actions.map(
    (action, index) =>
      `[${index}] ${action.kind ?? 'command'} — ${action.title}${
        action.disabled ? ` (disabled: ${action.disabled.reason})` : ''
      }`
  );
  return [`available actions: ${actions.length}`, ...lines].join('\n');
}

function emptySummary(): AppliedSummary {
  return { applied: false, files: [], totalEdits: 0, preview: [], errors: [], rolledBack: false };
}

function mergeFiles(target: FileChangeSummary[], incoming: FileChangeSummary[]): void {
  for (const file of incoming) {
    const existing = target.find((entry) => entry.path === file.path);
    if (existing) {
      existing.edits += file.edits;
      existing.added += file.added;
      existing.removed += file.removed;
    } else {
      target.push({ ...file });
    }
  }
}

async function applyEdits(
  summary: AppliedSummary,
  edits: LspWorkspaceEdit[],
  dryRun: boolean
): Promise<void> {
  for (const edit of edits) {
    const result = await applyWorkspaceEdit(edit, { dryRun });
    summary.totalEdits += result.totalEdits;
    mergeFiles(summary.files, result.files);
    if (result.preview) summary.preview.push(...result.preview);
    if (result.rolledBack) summary.rolledBack = true;
    if (result.error) summary.errors.push(result.error);
    if (result.applied) summary.applied = true;
  }
}

async function executeLspCodeAction(
  args: CodeActionInput,
  directory: string | undefined,
  registry: CodeActionRegistryLike
): Promise<ToolResult> {
  const configRoot = directory ?? process.cwd();

  let source: string;
  try {
    source = await readFilePromise(args.filePath, 'utf-8');
  } catch {
    return jsonResult({
      available: false,
      file: args.filePath,
      hint: `Could not read file: ${args.filePath}`,
    });
  }

  const range = resolveRange(source, args);
  if ('error' in range) {
    return jsonResult({ available: false, file: args.filePath, hint: range.error });
  }

  const resolved = registry.resolveServer(args.filePath, { configRoot });
  if (!resolved) {
    const config = registry.findConfig(args.filePath, configRoot);
    if (!config) {
      return jsonResult({
        available: false,
        file: args.filePath,
        range,
        hint: 'No LSP server configured for this file type. Add a server config for the file extension.',
      });
    }
    return jsonResult({
      available: false,
      file: args.filePath,
      range,
      hint: `LSP server "${config.command[0]}" is not installed.`,
      suggestion: config.installHint ?? `Install the language server for ${config.languageId}`,
    });
  }

  const uri = pathToFileURL(args.filePath).href;
  const { client, languageId } = resolved;

  try {
    await client.openDocument(uri, source, languageId);
    const actions = await client.codeAction(uri, range, { diagnostics: [] });

    if (args.mode !== 'apply') {
      return textResult(describeActions(actions, args.filePath, range));
    }

    const selected = selectAction(actions, args);
    if ('error' in selected) {
      return jsonResult({
        available: true,
        file: args.filePath,
        range,
        mode: 'apply',
        applied: false,
        error: selected.error,
        availableActions: actions.map((action, index) => ({
          index,
          kind: action.kind ?? null,
          title: action.title,
          ...(action.disabled ? { disabled: action.disabled.reason } : {}),
        })),
      });
    }

    let action = selected.action;
    const subject = { index: selected.index, kind: action.kind ?? null, title: action.title };

    if (action.disabled) {
      return jsonResult({
        available: true,
        file: args.filePath,
        range,
        mode: 'apply',
        action: subject,
        applied: false,
        error: `action is disabled: ${action.disabled.reason}`,
      });
    }

    // Deferred payloads (rust-analyzer and friends) arrive via codeAction/resolve.
    if (!action.edit && action.data !== undefined && client.resolveCodeAction) {
      const resolvedAction = await client.resolveCodeAction(action);
      if (resolvedAction) {
        action = resolvedAction.edit
          ? { ...resolvedAction, title: resolvedAction.title || action.title }
          : { ...action, ...resolvedAction, title: resolvedAction.title || action.title };
      }
    }

    const dryRun = args.dryRun === true;
    const summary = emptySummary();
    let commandExecuted = false;
    let commandError: string | undefined;

    // Two atomic units: the action's own edit first, then edits a command pushes
    // through workspace/applyEdit. A failing command leaves the first edit applied.
    if (action.edit) {
      await applyEdits(summary, [action.edit], dryRun);
    }

    if (action.command && !dryRun) {
      if (!client.executeCommand) {
        commandError = 'LSP client cannot execute commands';
      } else {
        try {
          await client.executeCommand(action.command.command, action.command.arguments);
          commandExecuted = true;
        } catch (err) {
          commandError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // Commands edit through `workspace/applyEdit`; apply whatever arrived.
    if (commandExecuted) {
      const drained = client.drainApplyEdits?.() ?? [];
      if (drained.length > 0) await applyEdits(summary, drained, false);
    }

    logDebugEvent('lsp_code_action.apply', {
      filePath: args.filePath,
      range,
      kind: action.kind ?? null,
      title: action.title,
      dryRun,
      commandExecuted,
      applied: summary.applied,
      totalEdits: summary.totalEdits,
      files: summary.files.map((file) => file.path),
      errors: summary.errors,
    });

    const noEffect = !action.edit && !commandExecuted && commandError === undefined;

    return jsonResult({
      available: true,
      file: args.filePath,
      range,
      mode: 'apply',
      action: { ...subject, kind: action.kind ?? null, title: action.title },
      dryRun,
      applied: summary.applied,
      totalEdits: summary.totalEdits,
      files: summary.files,
      ...(summary.preview.length > 0 ? { preview: summary.preview } : {}),
      ...(summary.rolledBack ? { rolledBack: true } : {}),
      ...(commandExecuted ? { commandExecuted: true } : {}),
      ...(dryRun && action.command ? { wouldExecuteCommand: true } : {}),
      ...(summary.errors.length > 0 ? { error: summary.errors.join('; ') } : {}),
      ...(commandError ? { commandError } : {}),
      ...(noEffect
        ? {
            error: action.command
              ? 'action produced no edits'
              : 'action produced no edits and no command',
          }
        : {}),
    });
  } catch (err) {
    return jsonResult({
      available: true,
      file: args.filePath,
      range,
      mode: args.mode ?? 'list',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the `lsp_code_action` tool. `list` shows one compact line per action;
 * `apply` selects one action by index, exact title or exact kind.
 */
export function createLspCodeActionTool(context: CodeActionToolContext = {}): ToolDefinition {
  return tool({
    description:
      'List and apply LSP code actions for a range (refactorings, quick fixes, source actions). Examples: Go extract function/variable and stub interface methods, Rust extract function and fill match arms, TypeScript/JavaScript extract function/constant and organize imports. Language-agnostic — any language with a registered LSP server. Returns compact path:line references, never full file contents.',
    args: {
      filePath: z.string().describe('Absolute file path'),
      mode: z
        .enum(['list', 'apply'])
        .default('list')
        .describe('list available actions, or apply one selected action'),
      line: z
        .number()
        .optional()
        .describe('1-based start line; omit to use the whole file as the range'),
      column: z.number().optional().describe('1-based start column (default: 1)'),
      endLine: z.number().optional().describe('1-based end line (default: line)'),
      endColumn: z
        .number()
        .optional()
        .describe('1-based end column (default: end of the end line)'),
      kind: z
        .string()
        .optional()
        .describe('Exact action kind to apply, e.g. refactor.extract.function'),
      title: z.string().optional().describe('Exact action title to apply'),
      index: z.number().optional().describe('0-based index from the list output'),
      dryRun: z
        .boolean()
        .default(false)
        .describe('Apply mode only: compute the edits and preview them without writing'),
    },
    execute: async (args, ctx) => {
      const registry = context.registry ?? getLspRegistry();
      return executeLspCodeAction(args, ctx.directory, registry);
    },
  });
}

/** Standalone instance used by the `lsp` module. */
export const lspCodeActionTool = createLspCodeActionTool();
