// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import type { ModuleDefinition } from '../lib/modules/registry';

export const imagelabModule: ModuleDefinition = {
  id: 'imagelab',
  requires: [],
  tools: async () => {
    const [
      { imgDiffTool },
      { imgSampleTool },
      { imgCropScaleTool },
      { imgComposeTool },
      { sixelDecodeTool },
      { contrastCheckTool },
    ] = await Promise.all([
      import('../tools/img-diff'),
      import('../tools/img-sample'),
      import('../tools/img-crop-scale'),
      import('../tools/img-compose'),
      import('../tools/sixel-decode'),
      import('../tools/contrast-check'),
    ]);

    return {
      img_diff: imgDiffTool,
      img_sample: imgSampleTool,
      img_crop_scale: imgCropScaleTool,
      img_compose: imgComposeTool,
      sixel_decode: sixelDecodeTool,
      contrast_check: contrastCheckTool,
    };
  },
};
