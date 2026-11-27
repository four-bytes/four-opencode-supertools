// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { Plugin } from '@opencode-ai/plugin';
import { buildToolMap } from './lib/modules/registry';
import { peekLspRegistry } from './lib/lsp-registry';

const FourOpencodeSupertools: Plugin = async (ctx, options) => {
  const logger = (level: 'warn' | 'info' | 'debug', message: string) => {
    try {
      void ctx?.client?.app
        ?.log({ body: { service: 'four-opencode-supertools', level, message } })
        ?.catch?.(() => {});
    } catch {
      // never throw from logging
    }
  };

  const tool = await buildToolMap(options, {
    directory: ctx?.directory,
    worktree: ctx?.worktree,
    logger,
  });

  const dispose = async (): Promise<void> => {
    await peekLspRegistry()?.dispose();
  };

  return { tool, dispose };
};

export default FourOpencodeSupertools;
