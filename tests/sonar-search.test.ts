// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sonarSearchTool } from '../src/tools/sonar-search';

type MockResponse = {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

const originalFetch = globalThis.fetch;

function mockFetch(response: MockResponse): void {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

describe('sonar_search tool', () => {
  beforeEach(() => {
    process.env.PERPLEXITY_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.PERPLEXITY_API_KEY;
  });

  it('returns answer and citations on success', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'The answer is 42.' } }],
        citations: ['https://example.com/a', 'https://example.com/b'],
      }),
    });

    const result = await sonarSearchTool.execute({ query: 'meaning of life' }, {} as never);

    expect(result.metadata.answer).toBe('The answer is 42.');
    expect(result.metadata.citations).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(result.metadata.model).toBe('sonar');
    expect(result.metadata.query).toBe('meaning of life');
    expect(result.title).toContain('meaning of life');
    expect(typeof result.output).toBe('string');
  });

  it('uses sonar-pro when requested', async () => {
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'deep' } }], citations: [] }),
    });

    const result = await sonarSearchTool.execute(
      { query: 'deep research', model: 'sonar-pro' },
      {} as never
    );

    expect(result.metadata.model).toBe('sonar-pro');
  });

  it('throws on API error with status', async () => {
    mockFetch({ ok: false, status: 429, text: async () => 'rate limited' });

    await expect(sonarSearchTool.execute({ query: 'x' }, {} as never)).rejects.toThrow('429');
  });

  it('rejects invalid model', async () => {
    await expect(
      sonarSearchTool.execute({ query: 'x', model: 'gpt-4' }, {} as never)
    ).rejects.toThrow('Invalid model');
  });

  it('rejects empty query', async () => {
    await expect(sonarSearchTool.execute({ query: '   ' }, {} as never)).rejects.toThrow(
      'query is required'
    );
  });

  it('never leaks the API key in output', async () => {
    process.env.PERPLEXITY_API_KEY = 'super-secret-key-xyz';
    mockFetch({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'answer' } }],
        citations: ['https://example.com'],
      }),
    });

    const result = await sonarSearchTool.execute({ query: 'leak test' }, {} as never);

    expect(JSON.stringify(result)).not.toContain('super-secret-key-xyz');
  });
});
