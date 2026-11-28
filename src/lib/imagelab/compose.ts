// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import {
  assertImageSize,
  blit,
  createImage,
  scaleNearest,
  type RasterImage,
  type Rgba,
} from './image.ts';
import { parseColour } from './colour.ts';
import { drawText } from './font.ts';

export type ComposeLayout = 'horizontal' | 'vertical' | 'grid';

export interface ComposePanel {
  image: RasterImage;
  label?: string;
}

export interface ComposeOptions {
  layout?: ComposeLayout;
  columns?: number;
  gap?: number;
  background?: Rgba;
  labelHeight?: number;
  labelColour?: Rgba;
  labelScale?: number;
  scale?: number;
}

export interface ComposePlacement {
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComposeResult {
  image: RasterImage;
  placements: ComposePlacement[];
  columns: number;
}

export function composeImages(panels: ComposePanel[], options: ComposeOptions = {}): ComposeResult {
  if (panels.length === 0) {
    throw new Error('composeImages requires at least one panel');
  }
  const layout: ComposeLayout = options.layout ?? 'horizontal';
  const gap = Math.max(0, Math.floor(options.gap ?? 8));
  const background = options.background ?? parseColour('#101010');
  const labelColour = options.labelColour ?? parseColour('#e6e6e6');
  const labelScale = options.labelScale ?? 1;
  const scale = options.scale ?? 1;
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`compose scale must be an integer >= 1, got ${scale}`);
  }
  const hasLabels = panels.some((panel) => typeof panel.label === 'string');
  const labelHeight = hasLabels ? Math.max(0, Math.floor(options.labelHeight ?? 12)) : 0;

  const scaled = panels.map((panel) =>
    scale === 1 ? panel.image : scaleNearest(panel.image, scale)
  );
  const panelWidths = scaled.map((image) => image.width);
  const panelHeights = scaled.map((image) => labelHeight + image.height);

  let totalWidth: number;
  let totalHeight: number;
  let columnsUsed = 1;
  const placements: ComposePlacement[] = [];

  if (layout === 'horizontal') {
    totalWidth = panelWidths.reduce((sum, width) => sum + width, 0) + gap * (panels.length - 1);
    totalHeight = Math.max(...panelHeights);
    let cursor = 0;
    for (let i = 0; i < panels.length; i++) {
      placements.push({
        label: panels[i].label,
        x: cursor,
        y: 0,
        width: panelWidths[i],
        height: panelHeights[i],
      });
      cursor += panelWidths[i] + gap;
    }
  } else if (layout === 'vertical') {
    totalWidth = Math.max(...panelWidths);
    totalHeight = panelHeights.reduce((sum, height) => sum + height, 0) + gap * (panels.length - 1);
    let cursor = 0;
    for (let i = 0; i < panels.length; i++) {
      placements.push({
        label: panels[i].label,
        x: 0,
        y: cursor,
        width: panelWidths[i],
        height: panelHeights[i],
      });
      cursor += panelHeights[i] + gap;
    }
  } else {
    const columns = Math.min(
      panels.length,
      Math.max(1, Math.floor(options.columns ?? Math.ceil(Math.sqrt(panels.length))))
    );
    columnsUsed = columns;
    const rows = Math.ceil(panels.length / columns);
    const cellWidth = Math.max(...panelWidths);
    const cellHeight = Math.max(...panelHeights);
    totalWidth = columns * cellWidth + gap * (columns - 1);
    totalHeight = rows * cellHeight + gap * (rows - 1);
    for (let i = 0; i < panels.length; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      placements.push({
        label: panels[i].label,
        x: col * (cellWidth + gap),
        y: row * (cellHeight + gap),
        width: panelWidths[i],
        height: panelHeights[i],
      });
    }
  }

  assertImageSize(totalWidth, totalHeight);
  const image = createImage(totalWidth, totalHeight, background);

  for (let i = 0; i < panels.length; i++) {
    const placement = placements[i];
    if (typeof placement.label === 'string' && labelHeight > 0) {
      drawText(image, placement.x + 2, placement.y + 2, placement.label, labelColour, labelScale);
    }
    blit(image, scaled[i], placement.x, placement.y + labelHeight);
  }

  return { image, placements, columns: columnsUsed };
}
