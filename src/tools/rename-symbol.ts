// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readFile as readFilePromise } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { tool } from '@opencode-ai/plugin';
import type { ToolDefinition, ToolResult } from '@opencode-ai/plugin';
import type { Node, Tree } from 'web-tree-sitter';
import { logDebugEvent } from '../lib/debug-logger';
import type { LspWorkspaceEdit, PrepareRenameResult } from '../lib/lsp-client';
import { getLspRegistry } from '../lib/lsp-registry';
import { applyWorkspaceEdit } from '../lib/workspace-edit';
import type { ModuleId } from '../lib/modules/detect';
import {
  PHP_RESERVED_WORDS,
  assertPhpIdentifier,
  lineStartOffsets,
  namedChildren,
  nearestAncestor,
  nodeText,
  parsePhpStrict,
  validatePhp,
  variableName,
  walkNodes,
} from '../lib/php-parser';

const z = tool.schema;

export type SymbolKind =
  'class' | 'method' | 'function' | 'variable' | 'interface' | 'trait' | 'property' | 'constant';

export interface RenameSymbolInput {
  filePath: string;
  oldName: string;
  newName: string;
  symbolKind?: SymbolKind;
  /** 1-based line used to disambiguate declarations with the same name. */
  line?: number;
  /** 1-based column (optional, requires line). */
  column?: number;
  preview?: boolean;
  /**
   * Include provably same-scope usages. Defaults to true. When false, skipped
   * same-class usages are reported as warnings instead of being silently missed.
   */
  renameUsages?: boolean;
}

export interface PreviewChange {
  line: number;
  oldText: string;
  newText: string;
  nodeType: string;
}

export interface RenameSymbolOutput {
  success: boolean;
  modifiedContent?: string;
  previewChanges?: PreviewChange[];
  replacementCount: number;
  warnings?: string[];
  error?: string;
}

/**
 * Nodes that own a member scope. Anonymous classes must be a boundary too:
 * falling back to the root node would let a rename touch an unrelated class.
 */
const CONTAINER_LIKE = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
  'anonymous_class',
]);

const FUNCTION_LIKE = new Set([
  'method_declaration',
  'function_definition',
  'anonymous_function',
  'arrow_function',
]);

interface Declaration {
  node: Node;
  nameNode: Node;
  kind: SymbolKind;
  /** Replacement start, already adjusted for a leading `$`. */
  startIndex: number;
  container: Node | null;
}

interface Target {
  startIndex: number;
  endIndex: number;
  line: number;
  nodeType: string;
  text: string;
}

function kindOfNode(node: Node): SymbolKind | null {
  switch (node.type) {
    case 'class_declaration':
    case 'enum_declaration':
      return 'class';
    case 'interface_declaration':
      return 'interface';
    case 'trait_declaration':
      return 'trait';
    case 'method_declaration':
      return 'method';
    case 'function_definition':
      return 'function';
    case 'property_element':
    case 'property_promotion_parameter':
      return 'property';
    case 'const_element':
      return 'constant';
    default:
      return null;
  }
}

function declarationNameNode(node: Node, kind: SymbolKind): Node | null {
  if (kind === 'constant') {
    return namedChildren(node).find((child) => child.type === 'name') ?? null;
  }
  return node.childForFieldName('name');
}

function collectDeclarations(root: Node, source: string, name: string): Declaration[] {
  const declarations: Declaration[] = [];
  walkNodes(root, (node) => {
    const kind = kindOfNode(node);
    if (!kind) return;
    const nameNode = declarationNameNode(node, kind);
    if (!nameNode) return;
    if (
      variableName(nameNode, source) !== name &&
      nodeText(source, nameNode).replace(/^\$/, '') !== name
    ) {
      return;
    }
    const isVariableName = nameNode.type === 'variable_name';
    declarations.push({
      node,
      nameNode,
      kind,
      startIndex: nameNode.startIndex + (isVariableName ? 1 : 0),
      container: nearestAncestor(node, CONTAINER_LIKE),
    });
  });
  return declarations;
}

function containerName(container: Node | null, source: string): string | null {
  if (!container) return null;
  const nameNode = container.childForFieldName('name');
  return nameNode ? nodeText(source, nameNode) : null;
}

function isThisReceiver(node: Node | null, source: string): boolean {
  if (!node || node.type !== 'variable_name') return false;
  return nodeText(source, node) === '$this';
}

function isSelfScope(node: Node | null, source: string, className: string | null): boolean {
  if (!node) return false;
  const text = nodeText(source, node);
  return text === 'self' || text === 'static' || (className !== null && text === className);
}

function collectMethodUsages(
  decl: Declaration,
  tree: Tree,
  source: string,
  oldName: string
): Target[] {
  const container = decl.container ?? tree.rootNode;
  const className = containerName(decl.container, source);
  const targets: Target[] = [];
  walkNodes(container, (node) => {
    if (node.type === 'member_call_expression' || node.type === 'nullsafe_member_call_expression') {
      const nameNode = node.childForFieldName('name');
      const objectNode = node.childForFieldName('object');
      if (!nameNode || nodeText(source, nameNode) !== oldName) return;
      if (!isThisReceiver(objectNode, source)) return;
      targets.push({
        startIndex: nameNode.startIndex,
        endIndex: nameNode.endIndex,
        line: nameNode.startPosition.row + 1,
        nodeType: node.type,
        text: oldName,
      });
    } else if (node.type === 'scoped_call_expression') {
      const nameNode = node.childForFieldName('name');
      const scopeNode = node.childForFieldName('scope');
      if (!nameNode || nodeText(source, nameNode) !== oldName) return;
      if (!isSelfScope(scopeNode, source, className)) return;
      targets.push({
        startIndex: nameNode.startIndex,
        endIndex: nameNode.endIndex,
        line: nameNode.startPosition.row + 1,
        nodeType: node.type,
        text: oldName,
      });
    }
  });
  return targets;
}

function collectPropertyUsages(
  decl: Declaration,
  tree: Tree,
  source: string,
  oldName: string
): Target[] {
  const container = decl.container ?? tree.rootNode;
  const className = containerName(decl.container, source);
  const targets: Target[] = [];
  walkNodes(container, (node) => {
    if (
      node.type === 'member_access_expression' ||
      node.type === 'nullsafe_member_access_expression'
    ) {
      const nameNode = node.childForFieldName('name');
      const objectNode = node.childForFieldName('object');
      if (!nameNode || nodeText(source, nameNode) !== oldName) return;
      if (!isThisReceiver(objectNode, source)) return;
      targets.push({
        startIndex: nameNode.startIndex,
        endIndex: nameNode.endIndex,
        line: nameNode.startPosition.row + 1,
        nodeType: node.type,
        text: oldName,
      });
    } else if (node.type === 'scoped_property_access_expression') {
      const nameNode = node.childForFieldName('name');
      const scopeNode = node.childForFieldName('scope');
      if (!nameNode || variableName(nameNode, source) !== oldName) return;
      if (!isSelfScope(scopeNode, source, className)) return;
      targets.push({
        startIndex: nameNode.startIndex + 1,
        endIndex: nameNode.endIndex,
        line: nameNode.startPosition.row + 1,
        nodeType: node.type,
        text: oldName,
      });
    }
  });
  return targets;
}

function collectConstantUsages(
  decl: Declaration,
  tree: Tree,
  source: string,
  oldName: string
): Target[] {
  const container = decl.container ?? tree.rootNode;
  const className = containerName(decl.container, source);
  const targets: Target[] = [];
  walkNodes(container, (node) => {
    if (node.type !== 'class_constant_access_expression') return;
    const children = namedChildren(node);
    const scopeNode = children[0] ?? null;
    const nameNode = children[1] ?? null;
    if (!nameNode || nodeText(source, nameNode) !== oldName) return;
    if (!isSelfScope(scopeNode, source, className)) return;
    targets.push({
      startIndex: nameNode.startIndex,
      endIndex: nameNode.endIndex,
      line: nameNode.startPosition.row + 1,
      nodeType: node.type,
      text: oldName,
    });
  });
  return targets;
}

function collectFunctionUsages(
  decl: Declaration,
  tree: Tree,
  source: string,
  oldName: string
): Target[] {
  const targets: Target[] = [];
  walkNodes(tree.rootNode, (node) => {
    if (node.type !== 'function_call_expression') return;
    const functionNode = node.childForFieldName('function');
    if (!functionNode || functionNode.type !== 'name') return;
    if (nodeText(source, functionNode) !== oldName) return;
    targets.push({
      startIndex: functionNode.startIndex,
      endIndex: functionNode.endIndex,
      line: functionNode.startPosition.row + 1,
      nodeType: node.type,
      text: oldName,
    });
  });
  return targets;
}

function isClassReferenceName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'named_type') return true;
  if (parent.type === 'object_creation_expression') {
    const first = parent.namedChild(0);
    return !!first && first.startIndex === node.startIndex;
  }
  if (parent.type === 'base_clause' || parent.type === 'class_interface_clause') return true;
  if (parent.type === 'scoped_call_expression') {
    const scope = parent.childForFieldName('scope');
    return !!scope && scope.startIndex === node.startIndex;
  }
  if (parent.type === 'class_constant_access_expression') {
    const first = parent.namedChild(0);
    return !!first && first.startIndex === node.startIndex;
  }
  if (parent.type === 'binary_expression') {
    const operator = parent.childForFieldName('operator');
    return !!operator && operator.type === 'instanceof';
  }
  if (parent.type === 'use_declaration') return true;
  if (parent.type === 'attribute') return true;
  return false;
}

function collectClassUsages(tree: Tree, source: string, oldName: string): Target[] {
  const targets: Target[] = [];
  walkNodes(tree.rootNode, (node) => {
    if (node.type !== 'name') return;
    if (nodeText(source, node) !== oldName) return;
    if (!isClassReferenceName(node)) return;
    targets.push({
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      line: node.startPosition.row + 1,
      nodeType: 'name',
      text: oldName,
    });
  });
  return targets;
}

function findScopeAtLine(root: Node, row: number): Node | null {
  let best: Node | null = null;
  walkNodes(root, (node) => {
    if (!FUNCTION_LIKE.has(node.type)) return;
    if (node.startPosition.row > row || node.endPosition.row < row) return;
    if (!best || node.endIndex - node.startIndex < best.endIndex - best.startIndex) best = node;
  });
  return best;
}

function collectVariableTargets(
  tree: Tree,
  source: string,
  name: string,
  row: number
): { targets: Target[]; error?: string } {
  const scope = findScopeAtLine(tree.rootNode, row);
  if (!scope) {
    return { targets: [], error: 'Variable rename requires a line inside a function or method' };
  }

  let nestedScope: Node | null = null;
  walkNodes(scope, (node) => {
    if (nestedScope) return;
    if (node !== scope && FUNCTION_LIKE.has(node.type)) nestedScope = node;
  });
  if (nestedScope) {
    return {
      targets: [],
      error:
        'Variable rename inside a scope that contains a nested closure/function is not supported (ambiguous capture semantics)',
    };
  }

  const targets: Target[] = [];
  walkNodes(scope, (node) => {
    if (node.type !== 'variable_name') return;
    if (variableName(node, source) !== name) return;
    targets.push({
      startIndex: node.startIndex + 1,
      endIndex: node.endIndex,
      line: node.startPosition.row + 1,
      nodeType: node.type,
      text: name,
    });
  });
  if (targets.length === 0) {
    return { targets: [], error: `Variable '$${name}' not found in the selected scope` };
  }
  return { targets };
}

function countSkippedMemberUsages(
  root: Node,
  source: string,
  oldName: string,
  selected: Set<number>
): number {
  let count = 0;
  walkNodes(root, (node) => {
    if (
      node.type === 'member_call_expression' ||
      node.type === 'nullsafe_member_call_expression' ||
      node.type === 'member_access_expression' ||
      node.type === 'nullsafe_member_access_expression'
    ) {
      const nameNode = node.childForFieldName('name');
      if (!nameNode || nodeText(source, nameNode) !== oldName) return;
      if (!selected.has(nameNode.startIndex)) count++;
    }
  });
  return count;
}

export async function renameSymbol(input: RenameSymbolInput): Promise<RenameSymbolOutput> {
  const warnings: string[] = [];
  let tree: Tree | undefined;
  try {
    if (input.newName === input.oldName) {
      return { success: false, replacementCount: 0, error: 'New name equals the existing name' };
    }
    assertPhpIdentifier(input.newName, 'New name');
    if (PHP_RESERVED_WORDS.has(input.oldName.replace(/^\$/, '').toLowerCase())) {
      return {
        success: false,
        replacementCount: 0,
        error: `'${input.oldName}' is a reserved PHP keyword and cannot be renamed as a symbol`,
      };
    }

    if (input.line !== undefined && (!Number.isInteger(input.line) || input.line < 1)) {
      return { success: false, replacementCount: 0, error: 'line must be a positive integer' };
    }
    if (input.column !== undefined) {
      if (input.line === undefined) {
        return { success: false, replacementCount: 0, error: 'column requires line' };
      }
      if (!Number.isInteger(input.column) || input.column < 1) {
        return { success: false, replacementCount: 0, error: 'column must be a positive integer' };
      }
    }

    const source = await readFilePromise(input.filePath, 'utf-8');
    tree = await parsePhpStrict(source, input.filePath);
    const oldName = input.oldName.replace(/^\$/, '');
    const renameUsages = input.renameUsages ?? true;

    const kind = input.symbolKind;
    const targets: Target[] = [];
    let matchedDeclarations: Declaration[] = [];

    if (kind === 'variable') {
      if (oldName === 'this') {
        return { success: false, replacementCount: 0, error: '$this cannot be renamed' };
      }
      if (input.line === undefined) {
        return {
          success: false,
          replacementCount: 0,
          error:
            'Variable rename requires a line number — variables are scope-bound and file-wide name matching is unsafe',
        };
      }
      const result = collectVariableTargets(tree, source, oldName, input.line - 1);
      if (result.error) return { success: false, replacementCount: 0, error: result.error };
      targets.push(...result.targets);
      warnings.push('Single-file variable rename; other scopes and files are not touched.');
    } else {
      matchedDeclarations = collectDeclarations(tree.rootNode, source, oldName).filter(
        (decl) => kind === undefined || decl.kind === kind
      );

      if (matchedDeclarations.length === 0) {
        return {
          success: false,
          replacementCount: 0,
          error: `Symbol '${oldName}' not found${kind ? ` (kind: ${kind})` : ''}`,
        };
      }

      if (input.line !== undefined) {
        const row = input.line - 1;
        const onLine = matchedDeclarations.filter(
          (decl) => decl.node.startPosition.row <= row && decl.node.endPosition.row >= row
        );
        if (onLine.length === 0) {
          const available = matchedDeclarations
            .map((decl) => decl.nameNode.startPosition.row + 1)
            .join(', ');
          return {
            success: false,
            replacementCount: 0,
            error: `No declaration of '${oldName}' at line ${input.line} (declarations at lines: ${available})`,
          };
        }
        matchedDeclarations = onLine;
      }

      if (input.line !== undefined && input.column !== undefined) {
        const offsets = lineStartOffsets(source);
        const offset = (offsets[input.line - 1] ?? 0) + input.column - 1;
        const atPosition = matchedDeclarations.filter(
          (decl) => decl.node.startIndex <= offset && decl.node.endIndex > offset
        );
        if (atPosition.length === 0) {
          return {
            success: false,
            replacementCount: 0,
            error: `No declaration of '${oldName}' at ${input.line}:${input.column}`,
          };
        }
        matchedDeclarations = atPosition;
      }

      if (matchedDeclarations.length > 1) {
        const lines = matchedDeclarations
          .map((decl) => decl.nameNode.startPosition.row + 1)
          .join(', ');
        return {
          success: false,
          replacementCount: 0,
          error: `Rename is ambiguous: '${oldName}' is declared at lines ${lines}. Pass line to select one declaration.`,
        };
      }

      const declaration = matchedDeclarations[0];
      targets.push({
        startIndex: declaration.startIndex,
        endIndex: declaration.nameNode.endIndex,
        line: declaration.nameNode.startPosition.row + 1,
        nodeType: declaration.node.type,
        text: oldName,
      });

      if (declaration.kind === 'method') {
        if (renameUsages) {
          targets.push(...collectMethodUsages(declaration, tree, source, oldName));
        }
      } else if (declaration.kind === 'property') {
        if (renameUsages) {
          targets.push(...collectPropertyUsages(declaration, tree, source, oldName));
        }
      } else if (declaration.kind === 'constant') {
        if (renameUsages) {
          targets.push(...collectConstantUsages(declaration, tree, source, oldName));
        }
      } else if (declaration.kind === 'function') {
        if (renameUsages) {
          targets.push(...collectFunctionUsages(declaration, tree, source, oldName));
        }
      } else if (renameUsages) {
        targets.push(...collectClassUsages(tree, source, oldName));
      }

      if (!renameUsages) {
        warnings.push(
          `renameUsages=false: same-scope usages of '${oldName}' were left unchanged on purpose.`
        );
      }

      if (
        declaration.kind === 'method' ||
        declaration.kind === 'property' ||
        declaration.kind === 'constant'
      ) {
        warnings.push(
          'Only this file is updated; references in other files (imports, call sites) are not resolved.'
        );
      } else if (
        declaration.kind === 'class' ||
        declaration.kind === 'interface' ||
        declaration.kind === 'trait'
      ) {
        warnings.push(
          'Only this file is updated; imports and references in other files are not resolved.'
        );
      } else if (declaration.kind === 'function') {
        warnings.push('Only this file is updated; call sites in other files are not resolved.');
      }
    }

    // Deduplicate by position — a symbol must never be replaced twice (that
    // corrupts offsets and produced `$titlee` style output).
    const unique = new Map<number, Target>();
    for (const target of targets) unique.set(target.startIndex, target);
    const finalTargets = [...unique.values()].sort((a, b) => a.startIndex - b.startIndex);

    if (finalTargets.length === 0) {
      return {
        success: false,
        replacementCount: 0,
        error: `Symbol '${oldName}' not found${kind ? ` (kind: ${kind})` : ''}`,
      };
    }

    const selected = new Set(finalTargets.map((target) => target.startIndex));
    const skipped = countSkippedMemberUsages(tree.rootNode, source, oldName, selected);
    if (skipped > 0 && matchedDeclarations.length === 1) {
      warnings.push(
        `${skipped} same-name member access(es) on other objects/classes were not renamed (structural matching, not semantic resolution).`
      );
    }

    if (input.preview) {
      return {
        success: true,
        replacementCount: finalTargets.length,
        previewChanges: finalTargets.map((target) => ({
          line: target.line,
          oldText: target.text,
          newText: input.newName,
          nodeType: target.nodeType,
        })),
        warnings,
      };
    }

    let modified = source;
    for (const target of [...finalTargets].sort((a, b) => b.startIndex - a.startIndex)) {
      modified =
        modified.slice(0, target.startIndex) + input.newName + modified.slice(target.endIndex);
    }

    await validatePhp(modified, 'Generated file');

    return {
      success: true,
      modifiedContent: modified,
      replacementCount: finalTargets.length,
      warnings,
    };
  } catch (err) {
    return {
      success: false,
      replacementCount: 0,
      error: String(err instanceof Error ? err.message : err),
    };
  } finally {
    tree?.delete();
  }
}

// ────────────────────────────────────────────────────────────────
// LSP-backed rename (Go, Rust, TypeScript/JavaScript, and any other
// language with a registered LSP server)
// ────────────────────────────────────────────────────────────────

export interface RenameClientLike {
  openDocument(uri: string, text: string, languageId: string): Promise<void>;
  prepareRename(
    uri: string,
    line: number,
    character: number,
    timeout?: number
  ): Promise<PrepareRenameResult | null>;
  rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
    timeout?: number
  ): Promise<LspWorkspaceEdit | null>;
}

export interface RenameRegistryLike {
  resolveServer(
    filePath: string,
    options?: { configRoot?: string }
  ): { client: RenameClientLike; languageId: string } | null;
  findConfig(
    filePath: string,
    configRoot?: string
  ): { command: string[]; installHint?: string; languageId: string } | null;
}

export interface RenameToolContext {
  /** Resolved active module ids — used to gate the LSP path per language. */
  modules?: ModuleId[];
  /** Injection seam for tests; defaults to the shared LSP registry. */
  registry?: RenameRegistryLike;
}

const RENAME_LANGUAGE_EXTENSIONS: Record<string, ModuleId> = {
  '.php': 'php',
  '.go': 'go',
  '.rs': 'rust',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'typescript',
  '.jsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.mjs': 'typescript',
  '.cjs': 'typescript',
};

function fileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return '';
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  if (lastDot < lastSlash) return '';
  return filePath.slice(lastDot).toLowerCase();
}

function requiredModuleFor(filePath: string): ModuleId | null {
  return RENAME_LANGUAGE_EXTENSIONS[fileExtension(filePath)] ?? null;
}

function jsonResult(payload: Record<string, unknown>): ToolResult {
  return { title: 'Rename Symbol', output: JSON.stringify(payload, null, 2), metadata: {} };
}

function moduleRefusal(module: ModuleId, filePath: string): ToolResult {
  return jsonResult({
    available: false,
    file: filePath,
    error: `Module '${module}' is not active. Enable it (modules: ["${module}"]) to rename this file type.`,
    hint: `Add "${module}" to the modules list, or use "modules": "auto" so it is detected.`,
  });
}

interface ResolvedPosition {
  line: number;
  character: number;
}

/**
 * Resolve the 0-based LSP position for the symbol. Explicit line/column win;
 * otherwise the first occurrence of `oldName` is used (deriving the column when
 * only a line is given).
 */
function locateSymbol(
  source: string,
  oldName: string,
  line?: number,
  column?: number
): ResolvedPosition | { error: string } {
  const lines = source.split('\n');

  if (line !== undefined) {
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      return { error: `line ${line} is outside the file` };
    }
    if (column !== undefined) {
      if (!Number.isInteger(column) || column < 1) {
        return { error: 'column must be a positive integer' };
      }
      return { line: line - 1, character: column - 1 };
    }
    const character = lines[line - 1].indexOf(oldName);
    if (character < 0) {
      return { error: `'${oldName}' not found on line ${line}` };
    }
    return { line: line - 1, character };
  }

  const index = source.indexOf(oldName);
  if (index < 0) {
    return { error: `'${oldName}' not found in the file; pass line and column to target it` };
  }
  const before = source.slice(0, index);
  return {
    line: before.split('\n').length - 1,
    character: index - (before.lastIndexOf('\n') + 1),
  };
}

async function executeLspRename(
  args: RenameSymbolInput & { dry_run?: boolean },
  directory: string | undefined,
  registry: RenameRegistryLike
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

  const located = locateSymbol(source, args.oldName, args.line, args.column);
  if ('error' in located) {
    return jsonResult({ available: false, file: args.filePath, hint: located.error });
  }

  const resolved = registry.resolveServer(args.filePath, { configRoot });
  if (!resolved) {
    const config = registry.findConfig(args.filePath, configRoot);
    if (!config) {
      return jsonResult({
        available: false,
        file: args.filePath,
        hint: 'No LSP server configured for this file type. Add a server config for the file extension.',
      });
    }
    return jsonResult({
      available: false,
      file: args.filePath,
      hint: `LSP server "${config.command[0]}" is not installed.`,
      suggestion: config.installHint ?? `Install the language server for ${config.languageId}`,
    });
  }

  const uri = pathToFileURL(args.filePath).href;
  const position = { line: located.line + 1, character: located.character + 1 };

  try {
    const { client, languageId } = resolved;
    await client.openDocument(uri, source, languageId);

    const prepared = await client.prepareRename(uri, located.line, located.character);
    if (!prepared) {
      return jsonResult({
        available: false,
        file: args.filePath,
        position,
        hint: 'rename not possible at this position',
      });
    }
    // `{ defaultBehavior: true }` means the server allows the rename and lets the
    // client use its default behaviour — there is no server range to validate.
    // `{ range, placeholder }` is informational; the position below is the
    // caller's and is used for the rename request either way.

    let workspaceEdit: LspWorkspaceEdit | null;
    try {
      workspaceEdit = await client.rename(uri, located.line, located.character, args.newName);
    } catch (err) {
      return jsonResult({
        available: true,
        file: args.filePath,
        position,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!workspaceEdit) {
      return jsonResult({
        available: true,
        file: args.filePath,
        position,
        error: 'Rename returned no changes',
      });
    }

    const dryRun = args.preview === true || args.dry_run === true;
    const applied = await applyWorkspaceEdit(workspaceEdit, { dryRun });

    logDebugEvent('rename_symbol.lsp', {
      filePath: args.filePath,
      oldName: args.oldName,
      newName: args.newName,
      line: located.line + 1,
      character: located.character + 1,
      dryRun,
      applied: applied.applied,
      totalEdits: applied.totalEdits,
      files: applied.files.map((file) => file.path),
      error: applied.error ?? null,
    });

    return jsonResult({
      available: true,
      file: args.filePath,
      newName: args.newName,
      applied: applied.applied,
      totalEdits: applied.totalEdits,
      files: applied.files,
      ...(applied.preview ? { preview: applied.preview } : {}),
      ...(applied.rolledBack ? { rolledBack: true } : {}),
      ...(applied.error ? { error: applied.error } : {}),
    });
  } catch (err) {
    return jsonResult({
      available: true,
      file: args.filePath,
      position,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the `rename_symbol` tool. PHP stays on the tree-sitter path; every
 * other language with a registered LSP server goes through prepareRename +
 * rename. The LSP path is gated on the target language's module.
 */
export function createRenameSymbolTool(context: RenameToolContext = {}): ToolDefinition {
  const { modules } = context;

  return tool({
    description:
      'Rename a symbol. PHP uses structural tree-sitter matching in ONE file — NOT semantic cross-file reference resolution. Go, Rust, TypeScript/JavaScript and other languages with a registered LSP server use prepareRename + rename and apply the WorkspaceEdit atomically. Pass line (and optionally column) to target the symbol; variable renames require a line.',
    args: {
      filePath: z.string().describe('Absolute file path'),
      oldName: z
        .string()
        .describe('Existing symbol name to rename (leading $ allowed for PHP variables)'),
      newName: z.string().describe('New identifier'),
      symbolKind: z
        .enum([
          'class',
          'method',
          'function',
          'variable',
          'interface',
          'trait',
          'property',
          'constant',
        ])
        .optional()
        .describe('PHP only: kind of symbol (default: any declaration kind)'),
      line: z
        .number()
        .optional()
        .describe(
          '1-based line used to disambiguate same-named declarations; required for PHP variables'
        ),
      column: z.number().optional().describe('Optional 1-based column hint (requires line)'),
      preview: z
        .boolean()
        .default(false)
        .describe('Return the changes without writing (PHP: no modified content; LSP: dry run)'),
      renameUsages: z
        .boolean()
        .default(true)
        .describe('PHP only: rename provably same-scope usages ($this->, self::, static::)'),
      dry_run: z
        .boolean()
        .default(false)
        .describe('LSP path only: compute the edits without writing any file'),
    },
    execute: async (args, ctx) => {
      // PHP keeps the existing tree-sitter implementation byte-for-byte.
      if (fileExtension(args.filePath) === '.php') {
        if (modules && !modules.includes('php')) {
          return moduleRefusal('php', args.filePath);
        }

        const result = await renameSymbol(args);
        if (!result.success) {
          throw new Error(`rename_symbol failed: ${result.error}`);
        }
        logDebugEvent('rename_symbol', {
          filePath: args.filePath,
          oldName: args.oldName,
          newName: args.newName,
          symbolKind: args.symbolKind ?? null,
          line: args.line ?? null,
          replacementCount: result.replacementCount,
          warnings: result.warnings ?? [],
        });
        if (args.preview) {
          return JSON.stringify(
            {
              replacementCount: result.replacementCount,
              previewChanges: result.previewChanges,
              warnings: result.warnings ?? [],
            },
            null,
            2
          );
        }
        return result.modifiedContent ?? '';
      }

      const requiredModule = requiredModuleFor(args.filePath);
      if (requiredModule && modules && !modules.includes(requiredModule)) {
        return moduleRefusal(requiredModule, args.filePath);
      }

      const registry = context.registry ?? getLspRegistry();
      return executeLspRename(args, ctx.directory, registry);
    },
  });
}

/**
 * Standalone instance without module gating — plugin registration always uses
 * `createRenameSymbolTool({ modules })`.
 */
export const renameSymbolTool = createRenameSymbolTool();
