// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { tool } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logDebugEvent } from '../lib/debug-logger';

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const VALID_MODELS = ['sonar', 'sonar-pro'];

function resolveApiKey(): string {
  const fromEnv = process.env.PERPLEXITY_API_KEY;
  if (fromEnv) return fromEnv;
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const authPath = join(dataHome, 'opencode', 'auth.json');
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8'));
    const key = parsed?.perplexity?.key;
    return typeof key === 'string' ? key : '';
  } catch {
    return '';
  }
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}

export const sonarSearchTool = tool({
  description: `Web search via Perplexity Sonar using your own account (no Exa rate limits). Returns a concise answer plus citation URLs. Defaults to the fast 'sonar' model; pass model:'sonar-pro' for deeper research.`,

  args: {
    query: tool.schema.string().describe('The search query'),
    model: tool.schema
      .string()
      .optional()
      .describe("Model: 'sonar' (fast, default) or 'sonar-pro' (deeper)"),
    max_tokens: tool.schema.number().optional().describe('Max answer tokens (default 1000)'),
  },

  async execute(args, _ctx) {
    const query = args.query.trim();
    if (!query) {
      throw new Error('query is required');
    }

    const model = args.model || 'sonar';
    if (!VALID_MODELS.includes(model)) {
      throw new Error(`Invalid model: ${model}. Must be one of: ${VALID_MODELS.join(', ')}`);
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      throw new Error(
        'Perplexity API key not found. Set PERPLEXITY_API_KEY or connect Perplexity in opencode.'
      );
    }

    logDebugEvent('sonar_search.start', { model, queryLength: query.length });

    const response = await fetch(PERPLEXITY_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: query }],
        max_tokens: args.max_tokens ?? 1000,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Perplexity API error ${response.status}: ${body.substring(0, 300)}`);
    }

    const data = (await response.json()) as PerplexityResponse;
    const answer = data.choices?.[0]?.message?.content?.trim() ?? '';
    const citations = Array.isArray(data.citations) ? data.citations : [];

    const result = { query, model, answer, citations };

    logDebugEvent('sonar_search.complete', {
      model,
      answerLength: answer.length,
      citationCount: citations.length,
    });

    return {
      title: `Search: ${query.substring(0, 60)}`,
      output: JSON.stringify(result, null, 2),
      metadata: result,
    };
  },
});
