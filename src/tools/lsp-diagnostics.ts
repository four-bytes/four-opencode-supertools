// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { getLspRegistry } from '../lib/lsp-registry.js';

const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_MAX_RESULTS = 100;

type Severity = 'error' | 'warning' | 'info' | 'hint' | 'all';

interface DiagnosticEntry {
  line: number;
  character: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string;
}

interface LspDiagnosticsOutput {
  available: boolean;
  file: string;
  count: number;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  diagnostics: DiagnosticEntry[];
  truncated: boolean;
  hint?: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…[truncated]';
}

function severityNumberToLabel(num: number): 'error' | 'warning' | 'info' | 'hint' {
  switch (num) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'info';
  }
}

function filterSeverity(
  diagnostics: DiagnosticEntry[],
  severity: Severity
): DiagnosticEntry[] {
  if (severity === 'all') return diagnostics;
  return diagnostics.filter((d) => d.severity === severity);
}

function sortDiagnostics(diagnostics: DiagnosticEntry[]): DiagnosticEntry[] {
  const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
  return [...diagnostics].sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return a.line - b.line;
  });
}

export const lspDiagnosticsTool = tool({
  description:
    'Get diagnostics (errors, warnings, hints) for file(s) via LSP. Saves ~70% tokens vs reading linter output.',

  permission: 'read',

  args: {
    file_path: tool.schema
      .string()
      .describe('Absolute path to file (or "project" for all)'),
    severity: tool.schema
      .string()
      .optional()
      .default('error')
      .describe('Filter: "error" | "warning" | "info" | "hint" | "all" (default: "error")'),
    max_results: tool.schema
      .number()
      .optional()
      .default(DEFAULT_MAX_RESULTS)
      .describe('Maximum number of diagnostics to return (default: 100)'),
  },

  async execute(args, ctx) {
    const { file_path, severity = 'error', max_results = DEFAULT_MAX_RESULTS } = args;

    logDebugEvent('lsp_diagnostics.start', { file_path, severity, max_results });

    const registry = getLspRegistry();

    // Project-wide diagnostics
    if (file_path === 'project') {
      return collectProjectDiagnostics(registry, severity, max_results);
    }

    // Single file diagnostics
    return collectFileDiagnostics(registry, file_path, severity, max_results);
  },
});

async function collectFileDiagnostics(
  registry: ReturnType<typeof getLspRegistry>,
  filePath: string,
  severity: Severity,
  maxResults: number
): Promise<LspDiagnosticsOutput> {
  const resolved = registry.resolveServer(filePath);

  if (!resolved) {
    const config = registry.findConfig(filePath);
    if (!config) {
      return {
        available: false,
        file: filePath,
        count: 0,
        errors: 0,
        warnings: 0,
        infos: 0,
        hints: 0,
        diagnostics: [],
        truncated: false,
        hint: `No LSP server configured for this file type. Add a server config for the file extension.`,
      };
    }

    return {
      available: false,
      file: filePath,
      count: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      diagnostics: [],
      truncated: false,
      hint: `LSP server "${config.command[0]}" is not installed.`,
    };
  }

  const { client, languageId, serverId } = resolved;
  const uri = `file://${filePath}`;

  // Read file content
  let fileText: string;
  try {
    fileText = await Bun.file(filePath).text();
  } catch {
    return {
      available: false,
      file: filePath,
      count: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      diagnostics: [],
      truncated: false,
      hint: `Could not read file: ${filePath}`,
    };
  }

  // Ensure document is open and tracked for project-wide access
  await client.openDocument(uri, fileText, languageId);
  registry.openDocumentForServer(uri, serverId);

  // Get diagnostics from LSP
  const rawDiagnostics = client.getDiagnostics(uri);

  // Transform and filter diagnostics
  const allDiagnostics: DiagnosticEntry[] = rawDiagnostics.map((d) => ({
    line: d.range.start.line + 1, // Convert 0-based to 1-based
    character: d.range.start.character + 1,
    severity: severityNumberToLabel(d.severity),
    message: truncate(d.message, MAX_MESSAGE_LENGTH),
    source: d.source,
    code: d.code?.toString(),
  }));

  const filtered = filterSeverity(allDiagnostics, severity);
  const sorted = sortDiagnostics(filtered);
  const truncated = sorted.length > maxResults;
  const diagnostics = sorted.slice(0, maxResults);

  const counts = {
    errors: allDiagnostics.filter((d) => d.severity === 'error').length,
    warnings: allDiagnostics.filter((d) => d.severity === 'warning').length,
    infos: allDiagnostics.filter((d) => d.severity === 'info').length,
    hints: allDiagnostics.filter((d) => d.severity === 'hint').length,
  };

  logDebugEvent('lsp_diagnostics.complete', {
    file: filePath,
    total: allDiagnostics.length,
    returned: diagnostics.length,
  });

  const output: LspDiagnosticsOutput = {
    available: true,
    file: filePath,
    count: diagnostics.length,
    ...counts,
    diagnostics,
    truncated,
  };

  if (truncated) {
    output.hint = `Only showing ${maxResults} of ${sorted.length} diagnostics. Use max_results to increase.`;
  }

  return output;
}

async function collectProjectDiagnostics(
  registry: ReturnType<typeof getLspRegistry>,
  severity: Severity,
  maxResults: number
): Promise<LspDiagnosticsOutput> {
  // Get all open documents from all servers
  const openDocs = registry.getOpenDocuments();

  if (openDocs.length === 0) {
    return {
      available: false,
      file: 'project',
      count: 0,
      errors: 0,
      warnings: 0,
      infos: 0,
      hints: 0,
      diagnostics: [],
      truncated: false,
      hint: `No open documents. Open files in your editor to get project-wide diagnostics.`,
    };
  }

  const allDiagnostics: (DiagnosticEntry & { file: string })[] = [];

  for (const doc of openDocs) {
    const rawDiagnostics = registry.getServer(doc.serverId)?.getDiagnostics(doc.uri) ?? [];
    for (const d of rawDiagnostics) {
      allDiagnostics.push({
        file: doc.uri,
        line: d.range.start.line + 1,
        character: d.range.start.character + 1,
        severity: severityNumberToLabel(d.severity),
        message: truncate(d.message, MAX_MESSAGE_LENGTH),
        source: d.source,
        code: d.code?.toString(),
      });
    }
  }

  const filtered = filterSeverity(allDiagnostics, severity);
  const sorted = sortDiagnostics(filtered);
  const truncated = sorted.length > maxResults;
  const diagnostics = sorted.slice(0, maxResults);

  const counts = {
    errors: allDiagnostics.filter((d) => d.severity === 'error').length,
    warnings: allDiagnostics.filter((d) => d.severity === 'warning').length,
    infos: allDiagnostics.filter((d) => d.severity === 'info').length,
    hints: allDiagnostics.filter((d) => d.severity === 'hint').length,
  };

  logDebugEvent('lsp_diagnostics.project_complete', {
    files: openDocs.length,
    total: allDiagnostics.length,
    returned: diagnostics.length,
  });

  const output: LspDiagnosticsOutput = {
    available: true,
    file: 'project',
    count: diagnostics.length,
    ...counts,
    diagnostics,
    truncated,
  };

  if (truncated) {
    output.hint = `Only showing ${maxResults} of ${sorted.length} diagnostics. Use max_results to increase.`;
  }

  return output;
}
