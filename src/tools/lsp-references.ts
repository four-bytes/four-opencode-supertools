// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { relative } from 'node:path';
import { getLspRegistry } from '../lib/lsp-registry.js';

const DEFAULT_MAX_RESULTS = 50;

interface LspReferencesOutput {
  available: boolean;
  symbol?: string;
  file: string;
  position: { line: number; character: number };
  count: number;
  references: { file: string; line: number; character: number }[];
  truncated: boolean;
  hint?: string;
}

function toRelativePath(uri: string, baseDir: string): string {
  const filePath = uri.startsWith('file://') ? uri.slice(7) : uri;
  const rel = relative(baseDir, filePath);
  if (rel.startsWith('..') || rel === '') return filePath;
  return './' + rel;
}

export const lspReferencesTool = tool({
  description:
    'Find all references to a symbol at a position via LSP. Saves ~90% tokens vs grep + manual tracing.',

  args: {
    file_path: tool.schema.string().describe('Absolute path to file'),
    line: tool.schema
      .number()
      .describe('1-based line number (user-friendly, converted to 0-based for LSP)'),
    character: tool.schema
      .number()
      .optional()
      .default(1)
      .describe('1-based character offset (default: 1)'),
    max_results: tool.schema
      .number()
      .optional()
      .default(DEFAULT_MAX_RESULTS)
      .describe('Maximum number of references to return (default: 50)'),
  },

  async execute(args, ctx) {
    const { file_path, line, character = 1, max_results = DEFAULT_MAX_RESULTS } = args;
    const validatedMax = Math.max(1, Math.floor(max_results)) || DEFAULT_MAX_RESULTS;

    // Convert to 0-based for LSP
    const lspLine = Math.max(0, line - 1);
    const lspChar = Math.max(0, character - 1);

    logDebugEvent('lsp_references.start', { file_path, line, character, lspLine, lspChar });

    const registry = getLspRegistry();
    const resolved = registry.resolveServer(file_path);

    if (!resolved) {
      const config = registry.findConfig(file_path);
      if (!config) {
        return {
          title: 'LSP References — No Server Configured',
          output: JSON.stringify({
            available: false,
            file: file_path,
            position: { line, character },
            count: 0,
            references: [],
            truncated: false,
            hint: `No LSP server configured for this file type. Add a server config for the file extension.`,
          } satisfies LspReferencesOutput),
          metadata: { file_path, line, character, available: false },
        };
      }

      return {
        title: 'LSP References — Server Not Installed',
        output: JSON.stringify({
          available: false,
          file: file_path,
          position: { line, character },
          count: 0,
          references: [],
          truncated: false,
          hint: `LSP server "${config.command[0]}" is not installed.`,
        } satisfies LspReferencesOutput),
        metadata: { file_path, line, character, available: false },
      };
    }

    const { client, languageId } = resolved;
    const uri = `file://${file_path}`;

    // Read file content
    let fileText: string;
    try {
      fileText = await Bun.file(file_path).text();
    } catch {
      return {
        title: 'LSP References — File Read Error',
        output: JSON.stringify({
          available: false,
          file: file_path,
          position: { line, character },
          count: 0,
          references: [],
          truncated: false,
          hint: `Could not read file: ${file_path}`,
        } satisfies LspReferencesOutput),
        metadata: { file_path, line, character, available: false },
      };
    }

    // Ensure document is open (async to wait for LSP handshake)
    await client.openDocument(uri, fileText, languageId);

    // Get all references
    const rawReferences = await client.references(uri, lspLine, lspChar);

    const baseDir = ctx.directory ?? process.cwd();
    const truncated = rawReferences.length > validatedMax;
    const limited = rawReferences.slice(0, validatedMax);

    const references = limited.map((loc) => ({
      file: toRelativePath(loc.uri, baseDir),
      line: loc.range.start.line + 1, // Convert 0-based to 1-based
      character: loc.range.start.character + 1,
    }));

    logDebugEvent('lsp_references.complete', {
      file: file_path,
      position: { line, character },
      total: rawReferences.length,
      returned: references.length,
    });

    const output: LspReferencesOutput = {
      available: true,
      file: file_path,
      position: { line, character },
      count: references.length,
      references,
      truncated,
    };

    if (truncated) {
      const remaining = rawReferences.length - validatedMax;
      output.hint = `Only showing ${validatedMax} of ${rawReferences.length} references. …and ${remaining} more.`;
    }

    return {
      title: 'LSP References',
      output: JSON.stringify(output),
      metadata: {
        file_path,
        line,
        character,
        available: true,
        count: output.count,
        truncated: output.truncated,
      },
    };
  },
});
