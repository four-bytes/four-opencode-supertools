// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readFile as readFilePromise } from 'node:fs/promises';
import { tool } from '@opencode-ai/plugin';
import type { Node, Tree } from 'web-tree-sitter';
import { logDebugEvent } from '../lib/debug-logger';
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

export const renameSymbolTool = tool({
  description:
    'Rename a PHP symbol declaration and provably same-scope references in ONE file. Structural tree-sitter matching with optional line targeting. This is NOT semantic cross-file reference resolution: imports and references in other files are not updated. Pass line to disambiguate duplicate names; variable renames require a line (scope-bound).',
  args: {
    filePath: z.string().describe('Absolute PHP file path'),
    oldName: z
      .string()
      .describe('Existing symbol name to rename (leading $ allowed for variables)'),
    newName: z.string().describe('New PHP identifier'),
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
      .describe('Kind of symbol (default: any declaration kind)'),
    line: z
      .number()
      .optional()
      .describe(
        '1-based line used to disambiguate same-named declarations; required for variables'
      ),
    column: z.number().optional().describe('Optional 1-based column hint (requires line)'),
    preview: z
      .boolean()
      .default(false)
      .describe('Return the changes without generating modified content'),
    renameUsages: z
      .boolean()
      .default(true)
      .describe('Rename provably same-scope usages ($this->, self::, static::, same class)'),
  },
  execute: async (args) => {
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
  },
});
