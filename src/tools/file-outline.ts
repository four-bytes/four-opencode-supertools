// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logDebugEvent } from '../lib/debug-logger';
import { getLspRegistry } from '../lib/lsp-registry.js';

export const MAX_OUTLINE_LINES = 100;
const DEFAULT_MAX_DEPTH = 2;

export interface OutlineSymbol {
  name: string;
  kind: string;
  /** 1-based line number of the symbol start. */
  line: number;
  /** Nesting level — 0 is a top-level declaration, 1 its direct member. */
  depth: number;
}

export interface OutlineFile {
  path: string;
  lineCount: number;
  symbols: OutlineSymbol[];
  /** True when the regex scanner produced the symbols instead of the LSP. */
  regexFallback: boolean;
}

/**
 * LSP SymbolKind (numeric) → short deterministic label.
 * Class→class · Method/Function/Constructor/Event/Operator→fn ·
 * Constant/EnumMember/Variable→const · Interface→interface · Enum→enum ·
 * Property/Field→property · everything else (Struct, TypeParameter, …)→type.
 */
const KIND_LABELS: Record<number, string> = {
  5: 'class',
  6: 'fn',
  7: 'property',
  8: 'property',
  9: 'fn',
  10: 'enum',
  11: 'interface',
  12: 'fn',
  13: 'const',
  14: 'const',
  22: 'const',
  23: 'type',
  24: 'fn',
  25: 'fn',
  26: 'type',
};

const DEFAULT_KIND = 'type';

export function symbolKindLabel(kind: number): string {
  return KIND_LABELS[kind] ?? DEFAULT_KIND;
}

interface RangeLike {
  start: { line: number };
}

/**
 * Read a symbol's range from either the hierarchical `DocumentSymbol` shape
 * (`range`) or the flat `SymbolInformation` shape (`location.range`).
 */
function extractRange(record: Record<string, unknown>): RangeLike | null {
  const range = record.range as RangeLike | undefined;
  if (range?.start && typeof range.start.line === 'number') return range;

  const location = record.location as { range?: RangeLike } | undefined;
  if (location?.range?.start && typeof location.range.start.line === 'number') {
    return location.range;
  }

  return null;
}

/**
 * Flatten an LSP document-symbol response to `maxDepth` levels.
 * Accepts both `DocumentSymbol[]` (hierarchical, `children`) and
 * `SymbolInformation[]` (flat, `location`). Nodes deeper than `maxDepth`
 * are cut, never flattened further.
 */
export function flattenDocumentSymbols(
  symbols: unknown[],
  maxDepth: number = DEFAULT_MAX_DEPTH
): OutlineSymbol[] {
  const limit = normalizeDepth(maxDepth);
  const result: OutlineSymbol[] = [];

  const walk = (nodes: unknown[], depth: number): void => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const record = node as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name : '';
      const kind = typeof record.kind === 'number' ? record.kind : -1;
      const range = extractRange(record);
      if (!name || !range) continue;
      if (depth >= limit) continue;

      result.push({
        name,
        kind: symbolKindLabel(kind),
        line: range.start.line + 1,
        depth,
      });

      const children = record.children;
      if (Array.isArray(children) && children.length > 0 && depth + 1 < limit) {
        walk(children, depth + 1);
      }
    }
  };

  walk(symbols, 0);
  return result;
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

function phpClassKind(keyword: string): string {
  switch (keyword) {
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    default:
      return 'type';
  }
}

/** PHP top-level declarations: class-likes, functions, constants. Column 0 only. */
function scanPhp(source: string): OutlineSymbol[] {
  const found: OutlineSymbol[] = [];

  const classRe = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/gm;
  for (const match of source.matchAll(classRe)) {
    found.push({
      name: match[2],
      kind: phpClassKind(match[1]),
      line: lineAt(source, match.index ?? 0),
      depth: 0,
    });
  }

  const fnRe =
    /^(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+(\w+)\s*(\([^)]*\))?/gm;
  for (const match of source.matchAll(fnRe)) {
    found.push({
      name: `${match[1]}${match[2] ?? '()'}`,
      kind: 'fn',
      line: lineAt(source, match.index ?? 0),
      depth: 0,
    });
  }

  const constRe = /^const\s+([A-Za-z_]\w*)/gm;
  for (const match of source.matchAll(constRe)) {
    found.push({
      name: match[1],
      kind: 'const',
      line: lineAt(source, match.index ?? 0),
      depth: 0,
    });
  }

  const defineRe = /^define\(\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(defineRe)) {
    found.push({
      name: match[1],
      kind: 'const',
      line: lineAt(source, match.index ?? 0),
      depth: 0,
    });
  }

  return sortByLine(found);
}

const TS_KIND: Record<string, string> = {
  class: 'class',
  function: 'fn',
  const: 'const',
  interface: 'interface',
  enum: 'enum',
  type: 'type',
};

/** TS/JS top-level declarations. Column 0 only to avoid matching function bodies. */
function scanTypescript(source: string): OutlineSymbol[] {
  const found: OutlineSymbol[] = [];
  const re =
    /^(?:export\s+)?(?:default\s+)?(?:(?:declare|abstract|async)\s+)*(class|function|const|interface|enum|type)\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/gm;

  for (const match of source.matchAll(re)) {
    const keyword = match[1];
    const name = match[2];
    const params = match[3];
    const isFunction = keyword === 'function';
    found.push({
      name: isFunction ? `${name}${params ?? '()'}` : name,
      kind: TS_KIND[keyword] ?? DEFAULT_KIND,
      line: lineAt(source, match.index ?? 0),
      depth: 0,
    });
  }

  return sortByLine(found);
}

function sortByLine(symbols: OutlineSymbol[]): OutlineSymbol[] {
  return symbols
    .map((symbol, index) => ({ symbol, index }))
    .sort((a, b) => a.symbol.line - b.symbol.line || a.index - b.index)
    .map((entry) => entry.symbol);
}

/**
 * Regex fallback scanner — used when no LSP server answers. Returns top-level
 * declarations only (no bodies, no nesting). Unknown extensions yield `[]`.
 */
export function scanSourceWithRegex(source: string, extension: string): OutlineSymbol[] {
  switch (extension.toLowerCase()) {
    case '.php':
      return scanPhp(source);
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return scanTypescript(source);
    default:
      return [];
  }
}

/**
 * Render an outline for one or more files. Caps the total rendered lines at
 * `maxLines` and appends `… (N more symbols)` when symbols were dropped.
 */
export function formatOutline(files: OutlineFile[], maxLines: number = MAX_OUTLINE_LINES): string {
  const entries: { text: string; symbol: boolean }[] = [];
  let totalSymbols = 0;

  for (const file of files) {
    const suffix = file.regexFallback ? ' [regex fallback]' : '';
    entries.push({ text: `## ${file.path} (${file.lineCount} lines)${suffix}`, symbol: false });
    for (const symbol of file.symbols) {
      const indent = '  '.repeat(Math.max(0, symbol.depth));
      entries.push({
        text: `${indent}- ${symbol.kind} ${symbol.name} (L${symbol.line})`,
        symbol: true,
      });
      totalSymbols++;
    }
  }

  const limit = normalizeLimit(maxLines);
  const lines: string[] = [];
  let emittedSymbols = 0;

  for (const entry of entries) {
    if (lines.length >= limit) break;
    lines.push(entry.text);
    if (entry.symbol) emittedSymbols++;
  }

  const dropped = totalSymbols - emittedSymbols;
  if (dropped > 0) lines.push(`… (${dropped} more symbols)`);

  return lines.join('\n');
}

function normalizeDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  return Math.max(1, Math.floor(value));
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return MAX_OUTLINE_LINES;
  return Math.floor(value);
}

function countLines(text: string): number {
  const withoutTrailingNewline = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (withoutTrailingNewline === '') return 0;
  return withoutTrailingNewline.split('\n').length;
}

function toDisplayPath(rawPath: string, absPath: string, baseDir: string): string {
  if (!isAbsolute(rawPath)) return rawPath.replace(/^\.\//, '');
  const rel = relative(baseDir, absPath);
  if (rel && !rel.startsWith('..')) return rel;
  return absPath;
}

function collectTargets(path: string | undefined, paths: string[] | undefined): string[] {
  const targets: string[] = [];
  if (typeof path === 'string' && path.length > 0) targets.push(path);
  if (Array.isArray(paths)) {
    for (const entry of paths) {
      if (typeof entry === 'string' && entry.length > 0) targets.push(entry);
    }
  }
  return [...new Set(targets)];
}

async function tryLspOutline(
  absPath: string,
  text: string,
  maxDepth: number
): Promise<OutlineSymbol[]> {
  let resolved: ReturnType<ReturnType<typeof getLspRegistry>['resolveServer']>;
  try {
    resolved = getLspRegistry().resolveServer(absPath);
  } catch {
    return [];
  }
  if (!resolved) return [];

  try {
    const uri = pathToFileURL(absPath).href;
    await resolved.client.openDocument(uri, text, resolved.languageId);
    const raw = await resolved.client.documentSymbol(uri);
    if (raw.length === 0) return [];
    return flattenDocumentSymbols(raw, maxDepth);
  } catch {
    return [];
  }
}

async function buildOutlineFile(
  rawPath: string,
  baseDir: string,
  maxDepth: number
): Promise<OutlineFile> {
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
  const displayPath = toDisplayPath(rawPath, absPath, baseDir);

  let text: string;
  try {
    text = await Bun.file(absPath).text();
  } catch {
    return { path: displayPath, lineCount: 0, symbols: [], regexFallback: false };
  }

  const lineCount = countLines(text);
  let symbols = await tryLspOutline(absPath, text, maxDepth);
  let regexFallback = false;

  if (symbols.length === 0) {
    symbols = scanSourceWithRegex(text, extname(absPath).toLowerCase());
    regexFallback = symbols.length > 0;
  }

  return { path: displayPath, lineCount, symbols, regexFallback };
}

export const fileOutlineTool = tool({
  description:
    'Get a structure-only outline of a file (symbols + line numbers) via LSP, with regex fallback for unsupported files. Never returns file contents. Saves ~95% tokens vs reading source.',

  args: {
    path: tool.schema
      .string()
      .describe('File to outline (absolute or relative to the project directory)'),
    paths: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Additional files to outline in the same call (batch)'),
    max_depth: tool.schema
      .number()
      .optional()
      .default(DEFAULT_MAX_DEPTH)
      .describe('Maximum nesting depth to include (default: 2)'),
  },

  async execute(args, ctx) {
    const maxDepth = normalizeDepth(args.max_depth);
    const baseDir = ctx.directory;

    logDebugEvent('file_outline.start', {
      path: args.path,
      extraPaths: args.paths?.length ?? 0,
      maxDepth,
    });

    try {
      const targets = collectTargets(args.path, args.paths);
      if (targets.length === 0) {
        return {
          title: 'File Outline',
          output: 'Error: no path provided',
          metadata: {},
        };
      }

      const files: OutlineFile[] = [];
      for (const target of targets) {
        files.push(await buildOutlineFile(target, baseDir, maxDepth));
      }

      const output = formatOutline(files, MAX_OUTLINE_LINES);
      const symbolCount = files.reduce((total, file) => total + file.symbols.length, 0);

      logDebugEvent('file_outline.complete', {
        files: files.length,
        symbols: symbolCount,
      });

      return {
        title: 'File Outline',
        output,
        metadata: { files: files.length, symbols: symbolCount },
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logDebugEvent('file_outline.error', { error: message });
      return {
        title: 'File Outline',
        output: `Error: ${message}`,
        metadata: {},
      };
    }
  },
});
