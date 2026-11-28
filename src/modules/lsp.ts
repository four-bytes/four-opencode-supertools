// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const lspModule: ModuleDefinition = {
  id: 'lsp',
  requires: [],
  tools: async () => {
    const [{ lspReferencesTool }, { lspHoverTool }, { fileOutlineTool }, { lspCodeActionTool }] =
      await Promise.all([
        import('../tools/lsp-references'),
        import('../tools/lsp-hover'),
        import('../tools/file-outline'),
        import('../tools/lsp-code-action'),
      ]);
    return {
      lsp_references: lspReferencesTool,
      lsp_hover: lspHoverTool,
      file_outline: fileOutlineTool,
      lsp_code_action: lspCodeActionTool,
    };
  },
};
