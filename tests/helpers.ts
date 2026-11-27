// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ToolResult } from '@opencode-ai/plugin';

type ObjectToolResult = Exclude<ToolResult, string>;

/**
 * Narrow a ToolResult to its structured branch. Tools return a bare string on
 * some error paths and an object everywhere else; tests that inspect metadata
 * need the object branch with a guaranteed metadata bag.
 */
export function toolObject(
  result: ToolResult
): ObjectToolResult & { metadata: NonNullable<ObjectToolResult['metadata']> } {
  if (typeof result === 'string') {
    throw new Error(`Expected a structured tool result, got a string: ${result}`);
  }
  return { ...result, metadata: result.metadata ?? {} };
}

/** Narrow a ToolResult to a string, unwrapping the object branch's output. */
export function toolString(result: ToolResult): string {
  return typeof result === 'string' ? result : result.output;
}
