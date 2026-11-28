// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { existsSync } from 'node:fs';
import { readFile as readFilePromise, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { tool } from '@opencode-ai/plugin';
import type { Node, Tree } from 'web-tree-sitter';
import { logDebugEvent } from '../lib/debug-logger';
import { namedChildren, nodeText, parsePhpStrict, walkNodes } from '../lib/php-parser';

const z = tool.schema;

const DEFAULT_MAX_FILES = 500;
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'vendor', '.idea']);

export interface RoutePathChange {
  line: number;
  oldText: string;
  newText: string;
}

export interface RouteRewriteResult {
  changed: boolean;
  output: string;
  changes: RoutePathChange[];
}

export interface ChangeRoutePathInput {
  oldPath: string;
  newPath: string;
  /** Scan root; defaults to the tool context directory. */
  directory?: string;
  /** Explicit files (absolute or relative to the scan root) — skips the walk. */
  files?: string[];
  /** Cap on scanned PHP files; defaults to 500. */
  maxFiles?: number;
  /** Report only, write nothing. */
  preview?: boolean;
}

export interface ChangeRoutePathOutput {
  success: boolean;
  scanned: number;
  changedFiles: number;
  changes: { file: string; line: number; oldText: string; newText: string }[];
  failedFiles?: { file: string; error: string }[];
  warnings?: string[];
  error?: string;
}

interface RouteTarget {
  startIndex: number;
  endIndex: number;
  line: number;
}

function isRouteAttributeName(name: string): boolean {
  return name === 'Route' || name.endsWith('\\Route');
}

/**
 * The literal content of a plain PHP string attribute argument. Double-quoted
 * literals without interpolation parse as `encapsed_string` with exactly one
 * `string_content` child. Anything with interpolation or concatenation is not a
 * plain literal and is left untouched.
 */
function literalContent(node: Node): Node | null {
  if (node.type === 'string') {
    return namedChildren(node).find((child) => child.type === 'string_content') ?? null;
  }
  if (node.type === 'encapsed_string') {
    const children = namedChildren(node);
    if (children.length === 1 && children[0].type === 'string_content') return children[0];
  }
  return null;
}

/** The path value node of a route attribute (`path:` or the first positional argument). */
function routePathValue(argumentsNode: Node, source: string): Node | null {
  const args = namedChildren(argumentsNode).filter((child) => child.type === 'argument');
  for (const arg of args) {
    const parts = namedChildren(arg);
    if (parts[0]?.type !== 'name') continue;
    if (nodeText(source, parts[0]) !== 'path') continue;
    return parts[1] ?? null;
  }
  const first = args[0];
  if (!first) return null;
  const parts = namedChildren(first);
  if (parts[0]?.type === 'name') return null;
  return parts[0] ?? null;
}

function findRouteTargets(root: Node, source: string, oldPath: string): RouteTarget[] {
  const targets: RouteTarget[] = [];
  walkNodes(root, (node) => {
    if (node.type !== 'attribute') return;
    const parts = namedChildren(node);
    const nameNode = parts[0];
    if (!nameNode || !isRouteAttributeName(nodeText(source, nameNode))) return;
    const argumentsNode = parts.find((child) => child.type === 'arguments');
    if (!argumentsNode) return;
    const valueNode = routePathValue(argumentsNode, source);
    if (!valueNode) return;
    const contentNode = literalContent(valueNode);
    if (!contentNode) return;
    if (nodeText(source, contentNode) !== oldPath) return;
    targets.push({
      startIndex: contentNode.startIndex,
      endIndex: contentNode.endIndex,
      line: contentNode.startPosition.row + 1,
    });
  });
  return targets;
}

/**
 * Rewrite every `#[Route()]` path argument that equals `oldPath` to `newPath`.
 * Pure per-file operation, AST-based via tree-sitter-php. Nothing outside the
 * replaced string spans changes byte-for-byte; quote style and line endings are
 * preserved.
 */
export async function rewriteRoutePaths(
  source: string,
  oldPath: string,
  newPath: string,
  label = 'PHP source'
): Promise<RouteRewriteResult> {
  let tree: Tree | undefined;
  try {
    tree = await parsePhpStrict(source, label);
    const targets = findRouteTargets(tree.rootNode, source, oldPath);
    if (targets.length === 0) {
      return { changed: false, output: source, changes: [] };
    }

    const unique = [...new Map(targets.map((target) => [target.startIndex, target])).values()].sort(
      (a, b) => a.startIndex - b.startIndex
    );

    let output = source;
    for (const target of [...unique].sort((a, b) => b.startIndex - a.startIndex)) {
      output = output.slice(0, target.startIndex) + newPath + output.slice(target.endIndex);
    }

    return {
      changed: true,
      output,
      changes: unique.map((target) => ({
        line: target.line,
        oldText: oldPath,
        newText: newPath,
      })),
    };
  } finally {
    tree?.delete();
  }
}

interface ScanResult {
  files: string[];
  truncated: boolean;
}

async function collectPhpFiles(root: string, maxFiles: number): Promise<ScanResult> {
  const files: string[] = [];

  async function walk(dir: string, relDir: string): Promise<void> {
    if (files.length > maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length > maxFiles) return;
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (relPath === 'var/cache' || relPath.endsWith('/var/cache')) continue;
        await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith('.php')) {
        files.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, '');
  const truncated = files.length > maxFiles;
  if (truncated) files.length = maxFiles;
  return { files, truncated };
}

/**
 * Project-wide `#[Route()]` path rewrite. The scan is explicit and bounded by
 * `maxFiles`; `files` replaces the walk with an explicit list.
 */
export async function changeRoutePath(
  input: ChangeRoutePathInput,
  defaultDirectory?: string
): Promise<ChangeRoutePathOutput> {
  const warnings: string[] = [];
  const failedFiles: { file: string; error: string }[] = [];
  const changes: ChangeRoutePathOutput['changes'] = [];

  try {
    if (input.oldPath === input.newPath) {
      return {
        success: false,
        scanned: 0,
        changedFiles: 0,
        changes: [],
        error: 'oldPath and newPath are identical',
      };
    }

    const root = resolve(input.directory ?? defaultDirectory ?? process.cwd());

    let files: string[];
    if (input.files && input.files.length > 0) {
      files = input.files.map((file) => (isAbsolute(file) ? file : resolve(root, file)));
    } else {
      const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
      const scan = await collectPhpFiles(root, maxFiles);
      files = scan.files;
      if (scan.truncated) {
        warnings.push(
          `Scan stopped at maxFiles (${maxFiles}); more PHP files may exist and were not inspected.`
        );
      }
    }

    files = [...new Set(files)].sort((a, b) => a.localeCompare(b));
    const scanned = files.length;
    let changedFiles = 0;

    for (const file of files) {
      try {
        if (!existsSync(file)) throw new Error(`File not found: ${file}`);
        const source = await readFilePromise(file, 'utf-8');
        const result = await rewriteRoutePaths(source, input.oldPath, input.newPath, file);
        if (!result.changed) continue;
        // Never write output that no longer parses.
        await parsePhpStrict(result.output, file).then((tree) => tree.delete());
        if (input.preview !== true) await writeFile(file, result.output, 'utf-8');
        changedFiles++;
        for (const change of result.changes) {
          changes.push({
            file,
            line: change.line,
            oldText: change.oldText,
            newText: change.newText,
          });
        }
      } catch (err) {
        failedFiles.push({ file, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const output: ChangeRoutePathOutput = {
      success: failedFiles.length === 0,
      scanned,
      changedFiles,
      changes,
    };
    if (failedFiles.length > 0) output.failedFiles = failedFiles;
    if (warnings.length > 0) output.warnings = warnings;
    return output;
  } catch (err) {
    return {
      success: false,
      scanned: 0,
      changedFiles: 0,
      changes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const changeRoutePathTool = tool({
  description:
    'Change route paths in PHP #[Route()] attributes. AST-based via tree-sitter-php; only the path argument is rewritten (positional first argument or named `path:`), and only on an exact match. Scans the project recursively (skipping .git, node_modules, vendor, var/cache, .idea) and is bounded by maxFiles; an optional explicit `files` list replaces the scan. `preview` reports changes and writes nothing.',
  args: {
    oldPath: z.string().describe('Exact route path to replace, e.g. /api/orders'),
    newPath: z.string().describe('Replacement route path'),
    directory: z.string().optional().describe('Scan root; defaults to the tool context directory'),
    files: z
      .array(z.string())
      .optional()
      .describe('Explicit files (absolute or relative to the scan root) — skips the scan'),
    maxFiles: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Maximum PHP files to inspect (default: ${DEFAULT_MAX_FILES})`),
    preview: z
      .boolean()
      .optional()
      .default(false)
      .describe('Report changes without writing any file'),
  },
  execute: async (args, ctx) => {
    const result = await changeRoutePath(args, ctx.directory);
    logDebugEvent('change_route_path', {
      oldPath: args.oldPath,
      newPath: args.newPath,
      directory: args.directory ?? ctx.directory ?? null,
      files: args.files ?? null,
      maxFiles: args.maxFiles ?? DEFAULT_MAX_FILES,
      preview: args.preview === true,
      scanned: result.scanned,
      changedFiles: result.changedFiles,
      failedFiles: result.failedFiles?.length ?? 0,
      warnings: result.warnings ?? [],
      error: result.error ?? null,
    });
    return JSON.stringify(result, null, 2);
  },
});
