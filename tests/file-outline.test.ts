// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  fileOutlineTool,
  flattenDocumentSymbols,
  formatOutline,
  scanSourceWithRegex,
  type OutlineFile,
  type OutlineSymbol,
} from '../src/tools/file-outline';
import { getLspRegistry, resetLspRegistry } from '../src/lib/lsp-registry';

// ────────────────────────────────────────────────────────────────
// Fixtures — LSP symbol trees
// ────────────────────────────────────────────────────────────────

function documentSymbol(
  name: string,
  kind: number,
  line: number,
  children: unknown[] = []
): Record<string, unknown> {
  return {
    name,
    kind,
    range: { start: { line, character: 0 }, end: { line: line + 1, character: 1 } },
    children,
  };
}

const NESTED_TREE = [
  documentSymbol('Outer', 5, 0, [
    documentSymbol('doWork', 6, 2),
    documentSymbol('Inner', 5, 6, [documentSymbol('innerMethod', 6, 8)]),
  ]),
  documentSymbol('TOP_CONST', 14, 22),
];

function summary(symbols: OutlineSymbol[]): string[] {
  return symbols.map((s) => `${'  '.repeat(s.depth)}${s.kind} ${s.name} (L${s.line})`);
}

// ────────────────────────────────────────────────────────────────
// Fixtures — regex fallback sources
// ────────────────────────────────────────────────────────────────

const PHP_SOURCE = [
  '<?php', // 1
  'namespace Foo;', // 2
  '', // 3
  "const DEFAULT_GROUP = 'x';", // 4
  '', // 5
  'interface Bar {}', // 6
  'trait Baz {}', // 7
  'enum Qux {}', // 8
  '', // 9
  'class InvoiceViews', // 10
  '{', // 11
  '    private const INNER = 1;', // 12
  '', // 13
  '    public function getViews(): array', // 14
  '    {', // 15
  '        return [];', // 16
  '    }', // 17
  '}', // 18
  '', // 19
  'function buildFilter($key) { return $key; }', // 20
].join('\n');

const TS_SOURCE = [
  "import { x } from './x';", // 1
  '', // 2
  "export const VERSION = '1';", // 3
  '', // 4
  'export interface Options {', // 5
  '  a: number;', // 6
  '}', // 7
  '', // 8
  'export type Cb = () => void;', // 9
  '', // 10
  'export enum Color {', // 11
  '  Red,', // 12
  '}', // 13
  '', // 14
  'export class Service {', // 15
  '  run() {}', // 16
  '}', // 17
  '', // 18
  'export function boot(name: string): void {}', // 19
  '', // 20
  'export async function load(id: number): Promise<void> {}', // 21
  '', // 22
  'const LOCAL = 2;', // 23
].join('\n');

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function mockCtx(dir: string) {
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

function outlineFile(overrides: Partial<OutlineFile> = {}): OutlineFile {
  return { path: 'file.ts', lineCount: 10, symbols: [], regexFallback: false, ...overrides };
}

// ────────────────────────────────────────────────────────────────
// flattenDocumentSymbols
// ────────────────────────────────────────────────────────────────

describe('flattenDocumentSymbols', () => {
  it('flattens a nested DocumentSymbol tree to two levels by default', () => {
    const result = flattenDocumentSymbols(NESTED_TREE);

    expect(summary(result)).toEqual([
      'class Outer (L1)',
      '  fn doWork (L3)',
      '  class Inner (L7)',
      'const TOP_CONST (L23)',
    ]);
  });

  it('cuts symbols deeper than max_depth instead of flattening them', () => {
    const result = flattenDocumentSymbols(NESTED_TREE, 3);

    expect(summary(result)).toEqual([
      'class Outer (L1)',
      '  fn doWork (L3)',
      '  class Inner (L7)',
      '    fn innerMethod (L9)',
      'const TOP_CONST (L23)',
    ]);
  });

  it('returns only top-level symbols when max_depth is 1', () => {
    const result = flattenDocumentSymbols(NESTED_TREE, 1);

    expect(summary(result)).toEqual(['class Outer (L1)', 'const TOP_CONST (L23)']);
  });

  it('handles the flat SymbolInformation shape via location.range', () => {
    const flat = [
      { name: 'foo', kind: 12, location: { uri: 'file:///x.ts', range: { start: { line: 4 } } } },
      { name: 'Bar', kind: 5, location: { uri: 'file:///x.ts', range: { start: { line: 9 } } } },
    ];

    const result = flattenDocumentSymbols(flat);

    expect(summary(result)).toEqual(['fn foo (L5)', 'class Bar (L10)']);
  });

  it('maps SymbolKind numbers to deterministic labels', () => {
    const kinds = [
      { name: 'C', kind: 5 },
      { name: 'M', kind: 6 },
      { name: 'F', kind: 12 },
      { name: 'Ctor', kind: 9 },
      { name: 'K', kind: 14 },
      { name: 'V', kind: 13 },
      { name: 'I', kind: 11 },
      { name: 'E', kind: 10 },
      { name: 'T', kind: 26 },
      { name: 'P', kind: 7 },
      { name: 'S', kind: 23 },
    ].map((k, i) => ({ ...k, location: { range: { start: { line: i } } } }));

    const result = flattenDocumentSymbols(kinds);

    expect(result.map((s) => s.kind)).toEqual([
      'class',
      'fn',
      'fn',
      'fn',
      'const',
      'const',
      'interface',
      'enum',
      'type',
      'property',
      'type',
    ]);
  });

  it('skips malformed nodes without throwing', () => {
    const result = flattenDocumentSymbols([null, 'nope', {}, { name: 'NoRange', kind: 5 }]);

    expect(result).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// scanSourceWithRegex
// ────────────────────────────────────────────────────────────────

describe('scanSourceWithRegex', () => {
  it('scans PHP top-level class-likes, functions and constants', () => {
    const result = scanSourceWithRegex(PHP_SOURCE, '.php');

    expect(summary(result)).toEqual([
      'const DEFAULT_GROUP (L4)',
      'interface Bar (L6)',
      'type Baz (L7)',
      'enum Qux (L8)',
      'class InvoiceViews (L10)',
      'fn buildFilter($key) (L20)',
    ]);
  });

  it('scans TypeScript top-level declarations', () => {
    const result = scanSourceWithRegex(TS_SOURCE, '.ts');

    expect(summary(result)).toEqual([
      'const VERSION (L3)',
      'interface Options (L5)',
      'type Cb (L9)',
      'enum Color (L11)',
      'class Service (L15)',
      'fn boot(name: string) (L19)',
      'fn load(id: number) (L21)',
      'const LOCAL (L23)',
    ]);
  });

  it('returns an empty list for unsupported extensions', () => {
    expect(scanSourceWithRegex('class Foo {}', '.txt')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// formatOutline
// ────────────────────────────────────────────────────────────────

describe('formatOutline', () => {
  it('renders an empty file as a bare header', () => {
    const output = formatOutline([outlineFile({ path: 'empty.ts', lineCount: 0 })]);

    expect(output).toBe('## empty.ts (0 lines)');
  });

  it('marks the header when the regex fallback produced the symbols', () => {
    const output = formatOutline([
      outlineFile({
        path: 'x.php',
        lineCount: 20,
        regexFallback: true,
        symbols: [{ name: 'Foo', kind: 'class', line: 10, depth: 0 }],
      }),
    ]);

    expect(output.split('\n')[0]).toBe('## x.php (20 lines) [regex fallback]');
  });

  it('indents nested symbols by depth', () => {
    const output = formatOutline([
      outlineFile({
        symbols: [
          { name: 'Outer', kind: 'class', line: 1, depth: 0 },
          { name: 'run', kind: 'fn', line: 3, depth: 1 },
        ],
      }),
    ]);

    expect(output.split('\n')).toEqual([
      '## file.ts (10 lines)',
      '- class Outer (L1)',
      '  - fn run (L3)',
    ]);
  });

  it('truncates past the line budget and reports dropped symbols', () => {
    const symbols: OutlineSymbol[] = Array.from({ length: 150 }, (_, i) => ({
      name: `sym${i}`,
      kind: 'fn',
      line: i + 1,
      depth: 0,
    }));

    const output = formatOutline([outlineFile({ path: 'big.ts', lineCount: 200, symbols })]);

    expect(output).toContain('… (51 more symbols)');
    expect(output.split('\n')).toHaveLength(101);
  });

  it('truncates across a batch of files', () => {
    const symbols: OutlineSymbol[] = Array.from({ length: 80 }, (_, i) => ({
      name: `s${i}`,
      kind: 'fn',
      line: i + 1,
      depth: 0,
    }));
    const files = [outlineFile({ path: 'a.ts', symbols }), outlineFile({ path: 'b.ts', symbols })];

    const output = formatOutline(files);

    expect(output).toContain('more symbols)');
    expect(output.split('\n').length).toBeLessThanOrEqual(101);
  });
});

// ────────────────────────────────────────────────────────────────
// file_outline tool (no LSP, empty registry → regex fallback)
// ────────────────────────────────────────────────────────────────

describe('file_outline tool', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `supertools-file-outline-${Date.now()}-${Math.random()}`);
    mkdirSync(testDir, { recursive: true });
    // Empty registry: resolveServer returns null without spawning `which`.
    resetLspRegistry();
    getLspRegistry([]);
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* test cleanup */
    }
    resetLspRegistry();
  });

  function outputOf(result: unknown): string {
    return (result as { output: string }).output;
  }

  it('returns a bare header for an empty file', async () => {
    writeFileSync(join(testDir, 'empty.txt'), '', 'utf-8');

    const result = await fileOutlineTool.execute({ path: 'empty.txt' }, mockCtx(testDir));

    expect(outputOf(result)).toBe('## empty.txt (0 lines)');
  });

  it('returns a bare header when the file cannot be read', async () => {
    const result = await fileOutlineTool.execute({ path: 'missing.txt' }, mockCtx(testDir));

    expect(outputOf(result)).toBe('## missing.txt (0 lines)');
  });

  it('falls back to the regex scanner and never leaks file contents', async () => {
    writeFileSync(join(testDir, 'sample.php'), PHP_SOURCE, 'utf-8');

    const result = await fileOutlineTool.execute({ path: 'sample.php' }, mockCtx(testDir));
    const output = outputOf(result);

    expect(output.split('\n')[0]).toBe('## sample.php (20 lines) [regex fallback]');
    expect(output).toContain('- class InvoiceViews (L10)');
    expect(output).toContain('- fn buildFilter($key) (L20)');
    expect(output).not.toContain('return $key');
  });

  it('outlines multiple files in one call', async () => {
    writeFileSync(join(testDir, 'a.php'), PHP_SOURCE, 'utf-8');
    writeFileSync(join(testDir, 'b.ts'), TS_SOURCE, 'utf-8');

    const result = await fileOutlineTool.execute(
      { path: 'a.php', paths: ['b.ts'] },
      mockCtx(testDir)
    );
    const output = outputOf(result);

    expect(output).toContain('## a.php (20 lines) [regex fallback]');
    expect(output).toContain('## b.ts (23 lines) [regex fallback]');
    expect(output).toContain('- class Service (L15)');
  });
});
