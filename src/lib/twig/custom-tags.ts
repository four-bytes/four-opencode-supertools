// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

/**
 * Bounded, best-effort discovery of custom Twig tags from project PHP sources.
 * It looks for Twig extensions (`AbstractExtension` / `ExtensionInterface`)
 * whose `getTokenParsers()` returns token parsers, then maps a token parser's
 * `getTag()` literal to the semantics of the built-in parser it extends.
 *
 * Only the five inheritance-relevant parents are mapped; everything else stays
 * unknown so the caller can report it. Nothing here throws: unreadable files,
 * syntax errors and a missing `src/` directory all degrade gracefully.
 */

import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { childByType, namedChildren, nodeText, parsePhp, walkNodes } from '../php-parser';

export interface CustomTagDiscovery {
  tags: Record<string, string>;
  scannedFiles: number;
  incomplete: boolean;
}

export interface DiscoverCustomTagsOptions {
  root: string;
  includeVendor?: boolean;
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 3000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

const EXTENSION_BASES: ReadonlySet<string> = new Set(['AbstractExtension', 'ExtensionInterface']);

/** Parent token parser → built-in Twig semantics. */
const PARENT_SEMANTICS: Readonly<Record<string, string>> = {
  ExtendsTokenParser: 'extends',
  IncludeTokenParser: 'include',
  EmbedTokenParser: 'embed',
  UseTokenParser: 'use',
  BlockTokenParser: 'block',
};

interface ClassInfo {
  name: string;
  extendsName: string | null;
  implementsNames: string[];
  getTagLiteral: string | null;
  tokenParserReturns: string[];
}

interface WalkState {
  files: string[];
  capped: boolean;
  unreadable: boolean;
}

function normalizeMaxFiles(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_FILES;
  }
  return Math.floor(value);
}

/** Strip a namespace prefix; only short class names are compared. */
function shortName(value: string): string {
  const parts = value.split('\\');
  return parts[parts.length - 1] ?? value;
}

function walkPhpFiles(base: string, state: WalkState, maxFiles: number): void {
  if (!existsSync(base)) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    state.unreadable = true;
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.files.length >= maxFiles) {
      state.capped = true;
      return;
    }
    const full = join(base, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkPhpFiles(full, state, maxFiles);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.php')) state.files.push(full);
  }
}

function stringLiteral(node: Node, source: string): string | null {
  const content = childByType(node, 'string_content');
  if (content) return nodeText(source, content);
  const text = nodeText(source, node);
  const match = /^(['"])([\s\S]*)\1$/.exec(text);
  return match ? match[2] : null;
}

function findStringReturn(methodNode: Node, source: string): string | null {
  let found: string | null = null;
  walkNodes(methodNode, (node) => {
    if (found !== null || node.type !== 'return_statement') return;
    for (const child of namedChildren(node)) {
      if (child.type === 'string') {
        found = stringLiteral(child, source);
        return;
      }
    }
  });
  return found;
}

function collectTokenParserReturns(methodNode: Node, source: string): string[] {
  const names = new Set<string>();
  walkNodes(methodNode, (node) => {
    if (
      node.type !== 'object_creation_expression' &&
      node.type !== 'class_constant_access_expression'
    ) {
      return;
    }
    const first = node.namedChild(0);
    if (first) names.add(shortName(nodeText(source, first)));
  });
  return [...names];
}

function collectClasses(source: string, root: Node, classes: Map<string, ClassInfo>): void {
  walkNodes(root, (node) => {
    if (node.type !== 'class_declaration') return;

    const nameNode = childByType(node, 'name');
    if (!nameNode) return;
    const name = nodeText(source, nameNode);

    const baseNode = childByType(node, 'base_clause');
    const baseChild = baseNode?.namedChild(0) ?? null;
    const extendsName = baseChild ? shortName(nodeText(source, baseChild)) : null;

    const interfaceNode = childByType(node, 'class_interface_clause');
    const implementsNames: string[] = [];
    if (interfaceNode) {
      for (const child of namedChildren(interfaceNode)) {
        implementsNames.push(shortName(nodeText(source, child)));
      }
    }

    const declaration = childByType(node, 'declaration_list');
    let getTagLiteral: string | null = null;
    const tokenParserReturns: string[] = [];

    if (declaration) {
      for (const member of namedChildren(declaration)) {
        if (member.type !== 'method_declaration') continue;
        const methodNameNode = childByType(member, 'name');
        if (!methodNameNode) continue;
        const methodName = nodeText(source, methodNameNode);
        if (methodName === 'getTag') {
          getTagLiteral = findStringReturn(member, source);
        } else if (methodName === 'getTokenParsers') {
          tokenParserReturns.push(...collectTokenParserReturns(member, source));
        }
      }
    }

    classes.set(name, {
      name,
      extendsName,
      implementsNames,
      getTagLiteral,
      tokenParserReturns,
    });
  });
}

function isExtension(info: ClassInfo): boolean {
  if (info.extendsName && EXTENSION_BASES.has(info.extendsName)) return true;
  return info.implementsNames.some((name) => EXTENSION_BASES.has(name));
}

/**
 * Discover custom Twig tags below `root/src` (and `root/vendor` on request).
 * Bounded by `maxFiles` (default 3000); capped or unreadable input sets
 * `incomplete` so the caller can mark the result partial.
 */
export async function discoverCustomTags(
  options: DiscoverCustomTagsOptions
): Promise<CustomTagDiscovery> {
  const tags: Record<string, string> = {};
  const maxFiles = normalizeMaxFiles(options.maxFiles);

  try {
    const state: WalkState = { files: [], capped: false, unreadable: false };
    walkPhpFiles(join(options.root, 'src'), state, maxFiles);
    if (options.includeVendor === true && !state.capped) {
      walkPhpFiles(join(options.root, 'vendor'), state, maxFiles);
    }

    const classes = new Map<string, ClassInfo>();

    for (const file of state.files) {
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        state.unreadable = true;
        continue;
      }

      // Cheap byte prefilter before paying for a tree-sitter parse.
      if (!source.includes('TokenParser') && !source.includes('Extension')) continue;

      let tree: Tree;
      try {
        tree = await parsePhp(source);
      } catch {
        continue;
      }

      try {
        collectClasses(source, tree.rootNode, classes);
      } catch {
        // A single malformed file must not abort discovery.
      } finally {
        tree.delete();
      }
    }

    for (const info of classes.values()) {
      if (!isExtension(info)) continue;
      for (const parserName of info.tokenParserReturns) {
        const parser = classes.get(shortName(parserName));
        if (!parser || !parser.getTagLiteral || !parser.extendsName) continue;
        const semantic = PARENT_SEMANTICS[parser.extendsName];
        if (!semantic) continue;
        tags[parser.getTagLiteral] = semantic;
      }
    }

    return {
      tags,
      scannedFiles: state.files.length,
      incomplete: state.capped || state.unreadable,
    };
  } catch {
    return { tags, scannedFiles: 0, incomplete: true };
  }
}
