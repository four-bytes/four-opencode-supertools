// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync, readFileSync } from 'node:fs';
import { readFile as readFilePromise } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tool } from '@opencode-ai/plugin';
import type { Node, Tree } from 'web-tree-sitter';
import { logDebugEvent } from '../lib/debug-logger';
import {
  assertPhpIdentifier,
  namedChildren,
  nodeText,
  parsePhpStrict,
  validatePhp,
  walkNodes,
} from '../lib/php-parser';

const z = tool.schema;

export interface MoveClassInput {
  sourcePath: string;
  className: string;
  targetPath: string;
  /** Explicit target namespace. Required when no Composer PSR-4 mapping applies. */
  namespace?: string;
}

export interface MoveClassOutput {
  success: boolean;
  sourceContent?: string;
  targetContent?: string;
  warnings?: string[];
  error?: string;
}

const CLASS_LIKE = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

const NAMESPACE_RE =
  /^[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*(\\[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)*$/;

function findComposerJson(fromFile: string): string | null {
  let dir = dirname(resolve(fromFile));
  for (let depth = 0; depth < 64; depth++) {
    const candidate = join(dir, 'composer.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

interface Psr4Mapping {
  prefix: string;
  directory: string;
}

function readPsr4Mappings(composerJson: string): Psr4Mapping[] {
  const raw = readFileSync(composerJson, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${composerJson} is not valid JSON`);
  }
  const root = parsed as Record<string, unknown>;
  const mappings: Psr4Mapping[] = [];
  for (const key of ['autoload', 'autoload-dev']) {
    const section = root[key] as Record<string, unknown> | undefined;
    const psr4 = section?.['psr-4'] as Record<string, unknown> | undefined;
    if (!psr4) continue;
    for (const [prefix, dir] of Object.entries(psr4)) {
      if (typeof dir === 'string') mappings.push({ prefix, directory: dir });
      else if (Array.isArray(dir)) {
        for (const entry of dir) {
          if (typeof entry === 'string') mappings.push({ prefix, directory: entry });
        }
      }
    }
  }
  return mappings;
}

function namespaceFromComposer(sourcePath: string, targetPath: string): string {
  const composerJson = findComposerJson(sourcePath);
  if (!composerJson) {
    throw new Error(
      'Cannot determine target namespace: no composer.json found. Pass an explicit `namespace` argument.'
    );
  }
  const mappings = readPsr4Mappings(composerJson);
  if (mappings.length === 0) {
    throw new Error(
      `Cannot determine target namespace: ${composerJson} has no autoload.psr-4 mapping. Pass an explicit \`namespace\` argument.`
    );
  }

  const projectRoot = dirname(composerJson);
  const absoluteTarget = isAbsolute(targetPath) ? targetPath : resolve(targetPath);
  const rel = relative(projectRoot, absoluteTarget).replace(/\\/g, '/');
  if (rel.startsWith('../') || rel === '..') {
    throw new Error(
      `Target path ${absoluteTarget} is outside the Composer project ${projectRoot}; cannot derive a namespace.`
    );
  }
  const relDir = (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '').replace(/^\.\//, '');

  const candidates: { namespace: string; score: number }[] = [];
  for (const mapping of mappings) {
    const directory = mapping.directory
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '');
    // An empty PSR-4 prefix maps to the global namespace — do not invent a
    // leading backslash, which would produce an invalid namespace.
    const prefix =
      mapping.prefix === ''
        ? ''
        : mapping.prefix.endsWith('\\')
          ? mapping.prefix
          : `${mapping.prefix}\\`;
    if (directory === '') {
      const remainder = relDir.replace(/\//g, '\\');
      const ns = `${prefix}${remainder}`.replace(/\\+$/, '');
      candidates.push({ namespace: ns, score: 0 });
      continue;
    }
    if (relDir !== directory && !relDir.startsWith(`${directory}/`)) continue;
    const remainder = relDir.slice(directory.length).replace(/^\/+/, '').replace(/\//g, '\\');
    const ns = `${prefix}${remainder}`.replace(/\\+$/, '');
    candidates.push({ namespace: ns, score: directory.length });
  }

  if (candidates.length === 0) {
    throw new Error(
      `Cannot derive a namespace for ${absoluteTarget} from ${composerJson}; pass an explicit \`namespace\` argument.`
    );
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const tied = candidates.filter((candidate) => candidate.score === best.score);
  if (new Set(tied.map((candidate) => candidate.namespace)).size > 1) {
    throw new Error(
      `Ambiguous Composer PSR-4 mapping for ${absoluteTarget}: ${tied
        .map((candidate) => candidate.namespace)
        .join(', ')}; pass an explicit \`namespace\` argument.`
    );
  }
  return best.namespace;
}

function validateNamespace(ns: string): void {
  // '' is the explicit sentinel for the global namespace, not an error.
  if (ns === '') return;
  if (ns.startsWith('\\')) {
    throw new Error('Namespace must not start with a backslash');
  }
  if (!NAMESPACE_RE.test(ns)) {
    throw new Error(`'${ns}' is not a valid PHP namespace`);
  }
}

function findOriginalNamespace(root: Node, source: string): { namespace: string; error?: string } {
  const definitions = namedChildren(root).filter((child) => child.type === 'namespace_definition');
  if (definitions.length > 1) {
    return { namespace: '', error: 'Files with multiple namespace blocks are not supported' };
  }
  if (definitions.length === 0) return { namespace: '' };
  const definition = definitions[0];
  for (let i = 0; i < definition.childCount; i++) {
    if (definition.child(i)?.type === '{') {
      return { namespace: '', error: 'Brace-delimited namespace blocks are not supported' };
    }
  }
  const nameNode = definition.childForFieldName('name');
  return { namespace: nameNode ? nodeText(source, nameNode).replace(/^\\/, '') : '' };
}

/**
 * A docblock/attribute can be a preceding sibling of the class node (attributes
 * are often children, docblocks are not). Include an immediately preceding
 * comment/attribute chain so the moved declaration keeps its documentation.
 */
function withLeadingComments(node: Node, source: string): { startIndex: number; text: string } {
  let startIndex = node.startIndex;
  const parent = node.parent;
  if (parent) {
    const siblings = namedChildren(parent);
    let index = siblings.findIndex((sibling) => sibling.startIndex === node.startIndex);
    while (index > 0) {
      const previous = siblings[index - 1];
      if (previous.type !== 'comment' && previous.type !== 'attribute_list') break;
      const gap = source.slice(previous.endIndex, startIndex);
      if (!/^[ \t]*\r?\n[ \t]*$/.test(gap)) break;
      startIndex = previous.startIndex;
      index--;
    }
  }
  return { startIndex, text: source.slice(startIndex, node.endIndex) };
}

function findClassNode(root: Node, source: string, className: string): Node | null {
  const found: Node[] = [];
  walkNodes(root, (node) => {
    if (found.length > 0 || !CLASS_LIKE.has(node.type)) return;
    // Only top-level declarations are movable. A class inside a function or a
    // conditional is not a namespace-level declaration; lifting it would
    // change when and whether it is defined.
    const parent = node.parent;
    if (!parent || (parent.type !== 'program' && parent.type !== 'namespace_definition')) return;
    const nameNode = node.childForFieldName('name');
    if (nameNode && nodeText(source, nameNode) === className) found.push(node);
  });
  return found[0] ?? null;
}

function useAliases(declaration: Node, source: string): string[] {
  const aliases: string[] = [];
  walkNodes(declaration, (node) => {
    if (node.type !== 'namespace_use_clause') return;
    const cleaned = nodeText(source, node)
      .replace(/^(function|const)\s+/i, '')
      .trim();
    const asMatch = cleaned.match(/\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    const alias = asMatch ? asMatch[1] : cleaned.split('\\').pop()?.trim();
    if (alias) aliases.push(alias);
  });
  return aliases;
}

/** Imports referenced by short name inside the moved class text. */
function referencedUseStatements(
  declarations: Node[],
  source: string,
  classText: string
): string[] {
  const statements: string[] = [];
  for (const declaration of declarations) {
    const aliases = useAliases(declaration, source);
    if (aliases.length === 0) continue;
    const referenced = aliases.some((alias) => {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // PHP class names are case-insensitive: `SomeHelper` and `somehelper`
      // refer to the same import.
      return new RegExp(`\\b${escaped}\\b`, 'i').test(classText);
    });
    if (referenced) statements.push(nodeText(source, declaration));
  }
  return statements;
}

const PHP_BUILTIN_CLASSES = new Set([
  'Attribute',
  'ArrayAccess',
  'ArrayIterator',
  'ArrayObject',
  'BackedEnum',
  'Closure',
  'Countable',
  'DateTime',
  'DateTimeImmutable',
  'DateTimeInterface',
  'Exception',
  'Fiber',
  'Generator',
  'InvalidArgumentException',
  'Iterator',
  'IteratorAggregate',
  'JsonException',
  'LogicException',
  'Override',
  'PDO',
  'PDOException',
  'RuntimeException',
  'SensitiveParameter',
  'Stringable',
  'Throwable',
  'Traversable',
  'UnitEnum',
  'WeakMap',
  'WeakReference',
  'stdClass',
]);

/**
 * Short class-like names that are neither imported nor built in. After a move
 * to another namespace they would silently resolve against the new namespace.
 */
function unresolvedShortNames(
  classText: string,
  declarations: Node[],
  source: string,
  className: string
): string[] {
  const aliases = new Set(declarations.flatMap((declaration) => useAliases(declaration, source)));
  const stripped = classText
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/#[^\n]*/g, '');
  const found = new Set<string>();
  const re = /(?<![\\\w$>:])\b([A-Z][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const name = match[1];
    if (name === className || aliases.has(name) || PHP_BUILTIN_CLASSES.has(name)) continue;
    found.add(name);
  }
  return [...found];
}

export async function moveClass(input: MoveClassInput): Promise<MoveClassOutput> {
  const warnings: string[] = [];
  let tree: Tree | undefined;
  try {
    assertPhpIdentifier(input.className, 'Class name');

    const absoluteSource = resolve(input.sourcePath);
    const absoluteTarget = resolve(input.targetPath);
    if (absoluteSource === absoluteTarget) {
      return { success: false, error: 'Source and target path are identical' };
    }

    const source = await readFilePromise(absoluteSource, 'utf-8');
    tree = await parsePhpStrict(source, absoluteSource);

    let targetNamespace: string;
    if (input.namespace !== undefined) {
      validateNamespace(input.namespace);
      targetNamespace = input.namespace;
      warnings.push(`Using explicit namespace '${targetNamespace}'`);
    } else {
      targetNamespace = namespaceFromComposer(absoluteSource, absoluteTarget);
      warnings.push(
        `Namespace '${targetNamespace}' derived from Composer PSR-4 mapping for ${absoluteTarget}`
      );
    }

    if (existsSync(absoluteTarget)) {
      const existing = await readFilePromise(absoluteTarget, 'utf-8');
      if (existing.trim() !== '') {
        return {
          success: false,
          error: `Target file already exists and is not empty: ${absoluteTarget} — refusing to overwrite`,
        };
      }
      warnings.push('Target file exists but is empty; content will be written into it');
    }

    const namespaceInfo = findOriginalNamespace(tree.rootNode, source);
    if (namespaceInfo.error) return { success: false, error: namespaceInfo.error };

    const classNode = findClassNode(tree.rootNode, source, input.className);
    if (!classNode) {
      return {
        success: false,
        error: `Class '${input.className}' not found in ${absoluteSource}`,
      };
    }

    const extracted = withLeadingComments(classNode, source);
    const classText = extracted.text;
    const useDeclarations = namedChildren(tree.rootNode).filter(
      (child) => child.type === 'namespace_use_declaration'
    );
    const imports = referencedUseStatements(useDeclarations, source, classText);
    warnings.push(
      imports.length === 0
        ? 'No referenced use statements needed in the target file'
        : `Copied ${imports.length} referenced use statement(s) to the target file`
    );
    const unresolved = unresolvedShortNames(classText, useDeclarations, source, input.className);
    if (unresolved.length > 0) {
      warnings.push(
        `Unresolved short names (no import, not built in): ${unresolved.join(
          ', '
        )} — in namespace '${targetNamespace}' they resolve to '${targetNamespace}\\…'; add imports or use fully-qualified names.`
      );
    }

    // Preserve the source declare() statements verbatim — never inject or
    // upgrade strict_types, which would silently change runtime semantics.
    const declares = namedChildren(tree.rootNode)
      .filter((child) => child.type === 'declare_statement')
      .map((child) => nodeText(source, child));

    let targetContent = '<?php\n\n';
    for (const declareStatement of declares) targetContent += `${declareStatement}\n\n`;
    if (targetNamespace !== '') targetContent += `namespace ${targetNamespace};\n\n`;
    for (const statement of imports) targetContent += `${statement}\n`;
    if (imports.length > 0) targetContent += '\n';
    targetContent += `${classText}\n`;

    await validatePhp(targetContent, 'Generated target file');

    let sourceContent = source.slice(0, extracted.startIndex) + source.slice(classNode.endIndex);
    sourceContent = sourceContent
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
    sourceContent += '\n';

    await validatePhp(sourceContent, 'Modified source file');

    return { success: true, sourceContent, targetContent, warnings };
  } catch (err) {
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  } finally {
    tree?.delete();
  }
}

export const moveClassTool = tool({
  description:
    'Move a PHP class-like declaration to another file. AST-based via tree-sitter-php. Preserves the source declare() block (strict_types is never injected or upgraded), copies referenced use statements, and resolves the target namespace from an explicit `namespace` or Composer PSR-4 mappings. Refuses to overwrite a non-empty target or guess a namespace.',
  args: {
    sourcePath: z.string().describe('Absolute path to current PHP file'),
    className: z.string().describe('Class name to move'),
    targetPath: z
      .string()
      .describe('Target PHP file path (absolute or relative to the current directory)'),
    namespace: z
      .string()
      .optional()
      .describe('Explicit target namespace (required when no Composer PSR-4 mapping applies)'),
  },
  execute: async (args) => {
    const result = await moveClass(args);
    if (!result.success) {
      throw new Error(`move_class failed: ${result.error}`);
    }
    logDebugEvent('move_class', {
      sourcePath: args.sourcePath,
      className: args.className,
      targetPath: args.targetPath,
    });
    return JSON.stringify(
      {
        sourceContent: result.sourceContent,
        targetContent: result.targetContent,
        warnings: result.warnings ?? [],
      },
      null,
      2
    );
  },
});
