// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Node, Parser, Tree } from 'web-tree-sitter';

const __dirname = dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate tree-sitter-php.wasm for both run modes:
 * - tests run from src/lib (project node_modules)
 * - production runs from the bundled dist/ file (wasm copied next to it)
 */
export function resolveTreeSitterWasm(): string {
  const found = firstExisting([
    resolve(__dirname, 'tree-sitter-php.wasm'),
    resolve(__dirname, '..', '..', 'node_modules', 'tree-sitter-php', 'tree-sitter-php.wasm'),
    resolve(__dirname, '..', 'node_modules', 'tree-sitter-php', 'tree-sitter-php.wasm'),
    resolve(process.cwd(), 'node_modules', 'tree-sitter-php', 'tree-sitter-php.wasm'),
  ]);
  if (!found) {
    throw new Error(
      'tree-sitter-php.wasm not found — run `bun install` (it is shipped in the tree-sitter-php package)'
    );
  }
  return found;
}

export function resolveWebTreeSitterWasm(): string {
  const found = firstExisting([
    resolve(__dirname, 'web-tree-sitter.wasm'),
    resolve(__dirname, '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    resolve(__dirname, '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
    resolve(process.cwd(), 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  ]);
  if (!found) {
    throw new Error('web-tree-sitter.wasm not found — run `bun install`');
  }
  return found;
}

let parserPromise: Promise<Parser> | null = null;

export async function getPhpParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init({
        locateFile: (url: string) =>
          url.endsWith('web-tree-sitter.wasm') ? resolveWebTreeSitterWasm() : url,
      });
      const language = await Language.load(resolveTreeSitterWasm());
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })();
  }
  return parserPromise;
}

export async function parsePhp(source: string): Promise<Tree> {
  const parser = await getPhpParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter failed to parse PHP source');
  return tree;
}

function findFirstErrorNode(node: Node): Node | null {
  if (node.type === 'ERROR' || node.isMissing) return node;
  for (const child of namedChildren(node)) {
    const found = findFirstErrorNode(child);
    if (found) return found;
  }
  return null;
}

function assertNoSyntaxError(tree: Tree, label: string): void {
  if (!tree.rootNode.hasError) return;
  const errorNode = findFirstErrorNode(tree.rootNode);
  const line = errorNode ? errorNode.startPosition.row + 1 : 0;
  throw new Error(`${label} contains a PHP syntax error${line > 0 ? ` at line ${line}` : ''}`);
}

/**
 * Parse and reject syntactically invalid input. Callers must never emit an
 * edit for source that does not parse: a wrong tree produces wrong edits.
 * The caller owns the returned tree and must call `tree.delete()` when done.
 */
export async function parsePhpStrict(source: string, label = 'PHP source'): Promise<Tree> {
  const tree = await parsePhp(source);
  assertNoSyntaxError(tree, label);
  return tree;
}

/**
 * Validate source without retaining the native tree. Use this for generated
 * output that is only checked, never inspected: `parsePhpStrict` would leak the
 * WASM `Tree` because the caller has nothing to delete.
 */
export async function validatePhp(source: string, label = 'PHP source'): Promise<void> {
  const tree = await parsePhp(source);
  try {
    assertNoSyntaxError(tree, label);
  } finally {
    tree.delete();
  }
}

export function nodeText(source: string, node: Node): string {
  return source.slice(node.startIndex, node.endIndex);
}

export function namedChildren(node: Node): Node[] {
  const children: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) children.push(child);
  }
  return children;
}

export function walkNodes(node: Node, visit: (child: Node) => void): void {
  visit(node);
  for (const child of namedChildren(node)) walkNodes(child, visit);
}

export function nearestAncestor(node: Node, types: ReadonlySet<string>): Node | null {
  let current = node.parent;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

export function childByType(node: Node, type: string): Node | null {
  for (const child of namedChildren(node)) {
    if (child.type === type) return child;
  }
  return null;
}

/**
 * String index (UTF-16 code units) of the first character of each 0-based row.
 * web-tree-sitter reports node indices in the same units, so they line up.
 */
export function lineStartOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** Source lines without line terminators. */
export function sourceLines(source: string): string[] {
  return source.split('\n');
}

export function indentationOfLine(source: string, row: number): string {
  const lines = sourceLines(source);
  const line = lines[row] ?? '';
  return line.match(/^[ \t]*/)?.[0] ?? '';
}

export function variableName(node: Node, source: string): string {
  return nodeText(source, node).replace(/^\$/, '');
}

const IDENTIFIER_RE = /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*$/;

export const PHP_RESERVED_WORDS = new Set([
  'abstract',
  'and',
  'array',
  'as',
  'break',
  'callable',
  'case',
  'catch',
  'class',
  'clone',
  'const',
  'continue',
  'declare',
  'default',
  'die',
  'do',
  'echo',
  'else',
  'elseif',
  'empty',
  'enddeclare',
  'endfor',
  'endforeach',
  'endif',
  'endswitch',
  'endwhile',
  'enum',
  'eval',
  'exit',
  'extends',
  'final',
  'finally',
  'fn',
  'for',
  'foreach',
  'function',
  'global',
  'goto',
  'if',
  'implements',
  'include',
  'include_once',
  'instanceof',
  'insteadof',
  'interface',
  'isset',
  'list',
  'match',
  'namespace',
  'new',
  'or',
  'print',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'require_once',
  'return',
  'static',
  'switch',
  'throw',
  'trait',
  'try',
  'unset',
  'use',
  'var',
  'while',
  'xor',
  'yield',
  'int',
  'float',
  'string',
  'bool',
  'void',
  'iterable',
  'object',
  'mixed',
  'never',
  'null',
  'false',
  'true',
]);

export function assertPhpIdentifier(name: string, label: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`${label} '${name}' is not a valid PHP identifier`);
  }
  if (PHP_RESERVED_WORDS.has(name.toLowerCase())) {
    throw new Error(`${label} '${name}' is a reserved PHP keyword`);
  }
}

export const PHP_SUPERGLOBALS = new Set([
  'GLOBALS',
  '_SERVER',
  '_GET',
  '_POST',
  '_FILES',
  '_COOKIE',
  '_SESSION',
  '_REQUEST',
  '_ENV',
]);
