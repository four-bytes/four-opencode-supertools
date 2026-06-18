// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect } from 'bun:test';
import { researchTool } from '../src/tools/research';

describe('research tool', () => {
  it('parses queries and returns structure', async () => {
    const ctx = {
      sessionID: 'test-session',
      messageID: 'test-message',
      agent: 'test-agent',
      directory: '/tmp',
      worktree: '/tmp',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'brain_search') return [{ content: 'brain result', score: 1.0 }];
        if (name === 'websearch') return [{ title: 'web result', url: 'https://example.com' }];
        return [];
      },
    };

    const result = await researchTool.execute(
      { queries: JSON.stringify(['test query']), scope: 'both' },
      ctx as any
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].query).toBe('test query');
    expect(result[0].brain).toBeDefined();
    expect(result[0].web).toBeDefined();
  });

  it('handles brain-only scope', async () => {
    const ctx = {
      callTool: async (name: string, _args: Record<string, unknown>) => {
        if (name === 'brain_search') return [{ content: 'brain result', score: 0.9 }];
        return [];
      },
    } as any;

    const result = await researchTool.execute(
      { queries: JSON.stringify(['brain query']), scope: 'brain' },
      ctx
    );

    expect(result[0].brain).toBeDefined();
    expect(result[0].web).toBeUndefined();
  });
});
