// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { getLspRegistry } from '../lib/lsp-registry.js';

const MAX_DOC_LENGTH = 2000;

function cleanMarkdown(text: string): string {
  // Strip code fences
  let cleaned = text.replace(/```[\w]*\n?/g, '');
  // Remove inline code backticks
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  // Remove bold/italic markers
  cleaned = cleaned.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');
  // Strip remaining markdown links, keep text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Collapse excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…[truncated]';
}

function extractType(doc: string): string {
  // Try to extract the primary type from the start of documentation
  // Common patterns: "function foo(): retType", "const x: Type", "class Foo"
  const rawLines = doc.split('\n');

  // Find first significant line, skipping code fences and empty lines
  let firstCodeLine = '';
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue; // skip empty lines
    if (trimmed === '```' || trimmed.startsWith('```')) continue; // skip fence lines
    firstCodeLine = trimmed;
    break;
  }

  if (!firstCodeLine) return doc;

  // Strip markdown formatting for cleaner type display
  return cleanMarkdown(firstCodeLine).slice(0, 300);
}

function extractDocumentation(raw: string): string {
  const cleaned = cleanMarkdown(raw);
  return truncate(cleaned, MAX_DOC_LENGTH);
}

interface LspHoverOutput {
  available: boolean;
  file: string;
  position: { line: number; character: number };
  type?: string;
  documentation?: string;
  fullContents?: string;
  hint?: string;
  suggestion?: string;
}

export const lspHoverTool = tool({
  description:
    'Get type information and documentation for a symbol at a position via LSP. Saves ~95% tokens vs reading source files.',

  args: {
    file_path: tool.schema.string().describe('Absolute path to the file'),
    line: tool.schema
      .number()
      .describe('1-based line number (user-friendly, converted to 0-based for LSP)'),
    character: tool.schema
      .number()
      .optional()
      .default(1)
      .describe('1-based character offset (default: 1)'),
  },

  async execute(args, _ctx) {
    const { file_path, line, character = 1 } = args;

    // Convert to 0-based for LSP
    const lspLine = Math.max(0, line - 1);
    const lspChar = Math.max(0, character - 1);

    logDebugEvent('lsp_hover.start', { file_path, line, character, lspLine, lspChar });

    const registry = getLspRegistry();
    const resolved = registry.resolveServer(file_path);

    if (!resolved) {
      const config = registry.findConfig(file_path);
      if (!config) {
        return JSON.stringify({
          available: false,
          file: file_path,
          position: { line, character },
          hint: `No LSP server configured for this file type. Add a server config for the file extension.`,
        } satisfies LspHoverOutput);
      }

      return JSON.stringify({
        available: false,
        file: file_path,
        position: { line, character },
        hint: `LSP server "${config.command[0]}" is not installed.`,
        suggestion: config.installHint ?? `Install the language server for ${config.languageId}`,
      } satisfies LspHoverOutput);
    }

    const { client, languageId } = resolved;
    const uri = `file://${file_path}`;

    // Read file content
    let fileText: string;
    try {
      fileText = await Bun.file(file_path).text();
    } catch {
      return JSON.stringify({
        available: false,
        file: file_path,
        position: { line, character },
        hint: `Could not read file: ${file_path}`,
      } satisfies LspHoverOutput);
    }

    // Ensure document is open (async to wait for LSP handshake)
    await client.openDocument(uri, fileText, languageId);

    // Request hover info
    const hoverResult = await client.hover(uri, lspLine, lspChar);

    if (!hoverResult || !hoverResult.contents || hoverResult.contents.trim().length === 0) {
      return JSON.stringify({
        available: true,
        file: file_path,
        position: { line, character },
        type: 'no information at this position',
      } satisfies LspHoverOutput);
    }

    const fullContents = hoverResult.contents;
    const type = extractType(fullContents);
    const documentation = extractDocumentation(fullContents);

    const output: LspHoverOutput = {
      available: true,
      file: file_path,
      position: { line, character },
    };

    if (type) output.type = type;
    if (documentation) output.documentation = documentation;
    output.fullContents = truncate(fullContents, 4000);

    logDebugEvent('lsp_hover.complete', { file_path, line, character, hasType: !!type });

    return JSON.stringify(output);
  },
});
