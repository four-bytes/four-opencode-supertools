import type { Plugin } from '@opencode-ai/plugin';
import { applyPatchTool } from './tools/apply-patch';

const FourOpencodeSupertools: Plugin = async (_ctx) => {
  return {
    tool: {
      apply_patch: applyPatchTool,
    },
  };
};

export default FourOpencodeSupertools;
