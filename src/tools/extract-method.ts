// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { readFile as readFilePromise } from 'node:fs/promises';
import { tool } from '@opencode-ai/plugin';
import type { Node } from 'web-tree-sitter';
import { logDebugEvent } from '../lib/debug-logger';
import {
  PHP_SUPERGLOBALS,
  assertPhpIdentifier,
  indentationOfLine,
  lineStartOffsets,
  namedChildren,
  nearestAncestor,
  parsePhpStrict,
  sourceLines,
  variableName,
  walkNodes,
} from '../lib/php-parser';

const z = tool.schema;

export interface ExtractMethodInput {
  filePath: string;
  startLine: number;
  endLine: number;
  newMethodName: string;
  visibility?: 'private' | 'protected' | 'public';
}

export interface ExtractMethodOutput {
  success: boolean;
  modifiedContent?: string;
  error?: string;
  /** Variables the extracted method receives as parameters. */
  parameters?: string[];
}

const CLASS_LIKE = new Set([
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
]);

const LOOP_OR_SWITCH = new Set([
  'for_statement',
  'foreach_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'match_expression',
]);

const UNSUPPORTED_NODES = new Set([
  'return_statement',
  'goto_statement',
  'function_definition',
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
  'global_declaration',
  'static_variable_declaration',
]);

function hasStaticModifier(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'static_modifier') return true;
  }
  return false;
}

const FUNCTION_LIKE = new Set([
  'method_declaration',
  'function_definition',
  'anonymous_function',
  'arrow_function',
]);

/** Innermost function-like node containing the selection (method or closure). */
function findInnermostFunctionLike(node: Node, startIndex: number, endIndex: number): Node | null {
  if (node.startIndex > startIndex || node.endIndex < endIndex) return null;
  if (FUNCTION_LIKE.has(node.type)) {
    for (const child of namedChildren(node)) {
      const nested = findInnermostFunctionLike(child, startIndex, endIndex);
      if (nested) return nested;
    }
    return node;
  }
  for (const child of namedChildren(node)) {
    const nested = findInnermostFunctionLike(child, startIndex, endIndex);
    if (nested) return nested;
  }
  return null;
}

function findEnclosingMethod(node: Node, startRow: number, endRow: number): Node | null {
  if (
    node.type === 'method_declaration' &&
    node.startPosition.row <= startRow &&
    node.endPosition.row >= endRow
  ) {
    return node;
  }
  for (const child of namedChildren(node)) {
    if (child.endPosition.row < startRow || child.startPosition.row > endRow) continue;
    const found = findEnclosingMethod(child, startRow, endRow);
    if (found) return found;
  }
  return null;
}

/** Innermost compound statement that fully contains the selection. */
function findInnermostBlock(node: Node, startRow: number, endRow: number): Node | null {
  if (node.startPosition.row > startRow || node.endPosition.row < endRow) return null;

  if (node.type === 'compound_statement' && node.startPosition.row !== node.endPosition.row) {
    for (const child of namedChildren(node)) {
      const nested = findInnermostBlock(child, startRow, endRow);
      if (nested) return nested;
    }
    return node;
  }

  for (const child of namedChildren(node)) {
    const nested = findInnermostBlock(child, startRow, endRow);
    if (nested) return nested;
  }
  return null;
}

function isAssignmentTarget(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  switch (parent.type) {
    case 'assignment_expression':
    case 'augmented_assignment_expression': {
      const left = parent.childForFieldName('left');
      return !!left && left.startIndex === node.startIndex && left.endIndex === node.endIndex;
    }
    case 'update_expression':
      return true;
    case 'pair':
      return true;
    case 'foreach_statement': {
      let asOffset = -1;
      for (let i = 0; i < parent.childCount; i++) {
        const child = parent.child(i);
        if (child?.type === 'as') {
          asOffset = child.startIndex;
          break;
        }
      }
      return asOffset >= 0 && node.startIndex > asOffset;
    }
    case 'catch_clause': {
      const variable = parent.childForFieldName('name');
      return !!variable && variable.startIndex === node.startIndex;
    }
    default:
      return false;
  }
}

function variablesIn(node: Node): Node[] {
  const found: Node[] = [];
  walkNodes(node, (child) => {
    if (child.type === 'variable_name') found.push(child);
  });
  return found;
}

function findUnsupported(statement: Node): Node | null {
  let offending: Node | null = null;
  walkNodes(statement, (node) => {
    if (offending) return;
    if (UNSUPPORTED_NODES.has(node.type) || node.type.startsWith('yield')) {
      offending = node;
    }
  });
  return offending;
}

function escapingJump(statement: Node, selectionStart: number, selectionEnd: number): Node | null {
  let escaping: Node | null = null;
  walkNodes(statement, (node) => {
    if (escaping) return;
    if (node.type !== 'break_statement' && node.type !== 'continue_statement') return;
    const target = nearestAncestor(node, LOOP_OR_SWITCH);
    if (!target || target.startIndex < selectionStart || target.endIndex > selectionEnd) {
      escaping = node;
    }
  });
  return escaping;
}

export async function extractMethod(input: ExtractMethodInput): Promise<ExtractMethodOutput> {
  try {
    assertPhpIdentifier(input.newMethodName, 'Method name');
    const visibility = input.visibility ?? 'private';

    const source = await readFilePromise(input.filePath, 'utf-8');
    const lines = sourceLines(source);
    const startRow = input.startLine - 1;
    const endRow = input.endLine - 1;

    if (
      input.startLine < 1 ||
      input.endLine < 1 ||
      input.endLine > lines.length ||
      input.startLine > input.endLine
    ) {
      return {
        success: false,
        error: `Invalid line range: ${input.startLine}-${input.endLine} (file has ${lines.length} lines)`,
      };
    }

    const tree = await parsePhpStrict(source, input.filePath);
    const method = findEnclosingMethod(tree.rootNode, startRow, endRow);
    if (!method) {
      return { success: false, error: 'Selection is not inside a PHP method' };
    }

    const body = method.childForFieldName('body');
    if (!body || body.type !== 'compound_statement') {
      return {
        success: false,
        error: 'Enclosing method has no body (abstract or interface method)',
      };
    }

    const block = findInnermostBlock(body, startRow, endRow);
    if (!block) {
      return {
        success: false,
        error:
          'Selection must consist of complete statements inside one block; the selection crosses a block boundary',
      };
    }

    const statements = namedChildren(block).filter(
      (child) => child.endPosition.row >= startRow && child.startPosition.row <= endRow
    );
    if (statements.length === 0) {
      return {
        success: false,
        error: 'Selection contains no complete statements to extract',
      };
    }

    const firstRow = Math.min(...statements.map((s) => s.startPosition.row));
    const lastRow = Math.max(...statements.map((s) => s.endPosition.row));

    if (firstRow < startRow || lastRow > endRow) {
      return {
        success: false,
        error: `Selection must align with complete statements (statements span lines ${firstRow + 1}-${lastRow + 1})`,
      };
    }

    // Reject extra non-blank lines that are not part of the selected statements,
    // e.g. a trailing method/class closing brace.
    for (let row = startRow; row <= endRow; row++) {
      if (row >= firstRow && row <= lastRow) continue;
      if ((lines[row] ?? '').trim() !== '') {
        return {
          success: false,
          error: `Selection contains code outside complete statements at line ${row + 1}`,
        };
      }
    }

    const selectionStart = statements[0].startIndex;
    const selectionEnd = statements[statements.length - 1].endIndex;

    // Reject constructs whose semantics would change or that cannot be inferred.
    for (const statement of statements) {
      const offending = findUnsupported(statement);
      if (offending) {
        return {
          success: false,
          error: `Cannot extract: selection contains an unsupported '${offending.type}' statement at line ${offending.startPosition.row + 1}`,
        };
      }
      const jump = escapingJump(statement, selectionStart, selectionEnd);
      if (jump) {
        return {
          success: false,
          error: `Cannot extract: '${jump.type.replace('_statement', '')}' at line ${jump.startPosition.row + 1} would jump out of the extracted block`,
        };
      }
    }

    // Existing member of the same class? A duplicate method is a fatal error.
    const classNode = nearestAncestor(method, CLASS_LIKE);
    const methodNames = new Set<string>();
    if (classNode) {
      const classBody = classNode.childForFieldName('body');
      if (classBody) {
        for (const member of namedChildren(classBody)) {
          if (member.type !== 'method_declaration') continue;
          const nameNode = member.childForFieldName('name');
          if (nameNode) methodNames.add(source.slice(nameNode.startIndex, nameNode.endIndex));
        }
      }
    }
    if (methodNames.has(input.newMethodName)) {
      return {
        success: false,
        error: `Cannot extract: method '${input.newMethodName}' already exists in the enclosing class`,
      };
    }

    const innermostFunction = findInnermostFunctionLike(method, selectionStart, selectionEnd);
    // A static method makes every nested closure static too.
    const isStatic =
      hasStaticModifier(method) ||
      (innermostFunction !== null &&
        innermostFunction !== method &&
        hasStaticModifier(innermostFunction));
    if (isStatic && /\$this\b/.test(source.slice(selectionStart, selectionEnd))) {
      return {
        success: false,
        error: `Cannot extract: selection uses $this inside static method '${source
          .slice(
            method.childForFieldName('name')?.startIndex ?? method.startIndex,
            method.childForFieldName('name')?.endIndex ?? method.endIndex
          )
          .trim()}'`,
      };
    }

    // Variables visible before the selection (parameters + earlier assignments).
    const definedBefore = new Set<string>();
    const parametersNode = method.childForFieldName('parameters');
    if (parametersNode) {
      for (const variable of variablesIn(parametersNode)) {
        definedBefore.add(variableName(variable, source));
      }
    }
    walkNodes(method, (node) => {
      if (node.type !== 'variable_name' || node.startIndex >= selectionStart) return;
      definedBefore.add(variableName(node, source));
    });

    const selectedVariables = statements
      .flatMap((statement) => variablesIn(statement))
      .sort((a, b) => a.startIndex - b.startIndex);

    const parameters: string[] = [];
    const assignedInSelection = new Set<string>();
    const namesInSelection = new Set<string>();
    for (const variable of selectedVariables) {
      const name = variableName(variable, source);
      if (name === 'this' || PHP_SUPERGLOBALS.has(name)) continue;
      namesInSelection.add(name);
      if (isAssignmentTarget(variable)) assignedInSelection.add(name);
      if (definedBefore.has(name) && !parameters.includes(name)) parameters.push(name);
    }

    // Variables created inside the selection that are read afterwards need a
    // return value; this tool has no return-value inference, so reject them.
    const usedAfter = new Set<string>();
    walkNodes(method, (node) => {
      if (node.type !== 'variable_name' || node.startIndex < selectionEnd) return;
      usedAfter.add(variableName(node, source));
    });
    const escapingVariables = [...assignedInSelection].filter((name) => usedAfter.has(name));
    if (escapingVariables.length > 0) {
      return {
        success: false,
        error: `Cannot extract: ${escapingVariables
          .map((name) => `$${name}`)
          .join(
            ', '
          )} assigned in the selection ${escapingVariables.length === 1 ? 'is' : 'are'} used after it (return values are not supported)`,
      };
    }

    // Variables that only come into existence inside the selection (e.g. a
    // by-reference output argument such as preg_match's $matches) cannot be
    // handed back to the caller without a return value.
    const createdVariables = [...namesInSelection].filter(
      (name) => usedAfter.has(name) && !definedBefore.has(name) && !assignedInSelection.has(name)
    );
    if (createdVariables.length > 0) {
      return {
        success: false,
        error: `Cannot extract: ${createdVariables
          .map((name) => `$${name}`)
          .join(
            ', '
          )} created inside the selection (by-reference output) ${createdVariables.length === 1 ? 'is' : 'are'} used after it`,
      };
    }

    const methodNameNode = method.childForFieldName('name');
    const methodIndent = indentationOfLine(
      source,
      methodNameNode?.startPosition.row ?? method.startPosition.row
    );
    const bodyIndent = indentationOfLine(source, firstRow);

    const firstDirect = namedChildren(body).find((child) => child.type !== 'comment');
    const directIndent = firstDirect
      ? indentationOfLine(source, firstDirect.startPosition.row)
      : methodIndent;
    let indentUnit = directIndent.startsWith(methodIndent)
      ? directIndent.slice(methodIndent.length)
      : '';
    if (indentUnit.length === 0) indentUnit = '    ';

    const selectedLines = lines.slice(firstRow, lastRow + 1);
    const bodyLines = selectedLines.map((line) => {
      if (line.trim() === '') return '';
      if (line.startsWith(bodyIndent))
        return `${methodIndent}${indentUnit}${line.slice(bodyIndent.length)}`;
      return `${methodIndent}${indentUnit}${line.trimStart()}`;
    });

    const receiver = isStatic ? 'self::' : '$this->';
    const callArguments = parameters.map((name) => `$${name}`).join(', ');
    // Pass parameters by reference: this preserves in-place mutations of
    // caller variables (sort(), preg_match() output args, …) exactly as the
    // original inline code behaved.
    const parameterList = parameters.map((name) => `&$${name}`).join(', ');
    const callSite = `${bodyIndent}${receiver}${input.newMethodName}(${callArguments});\n`;

    const offsets = lineStartOffsets(source);
    const replaceStart = offsets[firstRow];
    const replaceEnd = lastRow + 1 < offsets.length ? offsets[lastRow + 1] : source.length;

    const withCall = source.slice(0, replaceStart) + callSite + source.slice(replaceEnd);

    const adjustedInsertOffset = method.endIndex + (callSite.length - (replaceEnd - replaceStart));
    if (adjustedInsertOffset < 0 || adjustedInsertOffset > withCall.length) {
      return { success: false, error: 'Internal error: could not compute insertion position' };
    }

    const signature = `${methodIndent}${visibility} ${isStatic ? 'static ' : ''}function ${input.newMethodName}(${parameterList}): void`;
    const methodBlock = [
      '',
      signature,
      `${methodIndent}{`,
      ...bodyLines,
      `${methodIndent}}`,
      '',
    ].join('\n');

    const modified =
      withCall.slice(0, adjustedInsertOffset) + methodBlock + withCall.slice(adjustedInsertOffset);

    await parsePhpStrict(modified, 'Generated file');

    return { success: true, modifiedContent: modified, parameters };
  } catch (err) {
    return { success: false, error: String(err instanceof Error ? err.message : err) };
  }
}

export const extractMethodTool = tool({
  description:
    'Extract complete statements from a PHP method into a new method. AST-based via tree-sitter-php. Rejects partial statements, return/yield/goto, escaping break/continue, static-method $this use and values that escape the selection. Input: filePath, startLine, endLine, newMethodName, visibility. Output: modifiedContent + parameters or a clear error.',
  args: {
    filePath: z.string().describe('Absolute PHP file path'),
    startLine: z.number().describe('Start line (1-indexed, inclusive)'),
    endLine: z.number().describe('End line (1-indexed, inclusive)'),
    newMethodName: z.string().describe('Name for the new method'),
    visibility: z
      .enum(['private', 'protected', 'public'])
      .default('private')
      .describe('Method visibility'),
  },
  execute: async (args) => {
    const result = await extractMethod(args);
    if (!result.success) {
      throw new Error(`extract_method failed: ${result.error}`);
    }
    logDebugEvent('extract_method', {
      filePath: args.filePath,
      newMethodName: args.newMethodName,
      visibility: args.visibility ?? 'private',
      parameters: result.parameters ?? [],
    });
    return result.modifiedContent ?? '';
  },
});
