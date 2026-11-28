// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const termlabModule: ModuleDefinition = {
  id: 'termlab',
  requires: [],
  tools: async () => {
    const [
      { traceDecodeTool },
      { widthCheckTool },
      { termChecksumTool },
      { termRunTool },
      { traceReplayTool },
      { cellHistoryTool },
    ] = await Promise.all([
      import('../tools/trace-decode'),
      import('../tools/width-check'),
      import('../tools/term-checksum'),
      import('../tools/term-run'),
      import('../tools/trace-replay'),
      import('../tools/cell-history'),
    ]);

    return {
      trace_decode: traceDecodeTool,
      width_check: widthCheckTool,
      term_checksum: termChecksumTool,
      term_run: termRunTool,
      trace_replay: traceReplayTool,
      cell_history: cellHistoryTool,
    };
  },
};
