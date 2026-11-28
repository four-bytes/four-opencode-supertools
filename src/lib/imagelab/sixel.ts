// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import {
  MAX_IMAGE_PIXELS,
  clamp,
  createImage,
  fillRect,
  setPixel,
  type RasterImage,
  type Rgba,
} from './image.ts';
import { formatColour } from './colour.ts';

export interface SixelPaletteEntry {
  index: number;
  r: number;
  g: number;
  b: number;
  hex: string;
}

export interface SixelDecodeResult {
  width: number;
  height: number;
  bands: number;
  image: RasterImage;
  palette: SixelPaletteEntry[];
  coloursUsed: number;
  declared?: { width: number; height: number };
}

export interface SixelDecodeOptions {
  background?: Rgba;
  maxPixels?: number;
}

interface Register {
  r: number;
  g: number;
  b: number;
  defined: boolean;
  used: boolean;
}

interface ParseMetadata {
  maxX: number;
  maxY: number;
  declared: { width: number; height: number } | undefined;
  registers: Map<number, Register>;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input !== 'string') {
    return input;
  }
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input.charCodeAt(i) & 0xff;
  }
  return out;
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function hlsToRgb(
  hue: number,
  lightness: number,
  saturation: number
): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360;
  const l = clamp(lightness, 0, 100) / 100;
  const s = clamp(saturation, 0, 100) / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) {
    r1 = c;
    g1 = x;
  } else if (hp < 2) {
    r1 = x;
    g1 = c;
  } else if (hp < 3) {
    g1 = c;
    b1 = x;
  } else if (hp < 4) {
    g1 = x;
    b1 = c;
  } else if (hp < 5) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  const m = l - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function locateBody(bytes: Uint8Array): { start: number; end: number } {
  let introducer = -1;
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x50) {
      introducer = i;
      break;
    }
  }
  if (introducer < 0 && bytes[0] === 0x90) {
    introducer = 0;
  }
  if (introducer < 0) {
    return { start: 0, end: bytes.length };
  }
  let q = introducer + (bytes[introducer] === 0x90 ? 1 : 2);
  while (q < bytes.length && bytes[q] !== 0x71) {
    q++;
  }
  if (q >= bytes.length) {
    return { start: 0, end: bytes.length };
  }
  const start = q + 1;
  let end = bytes.length;
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0x9c) {
      end = i;
      break;
    }
    if (bytes[i] === 0x1b && i + 1 < bytes.length && bytes[i + 1] === 0x5c) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function parseSixel(
  bytes: Uint8Array,
  start: number,
  end: number,
  onPaint: (x: number, y: number, register: Register) => void,
  seed?: Map<number, Register>
): ParseMetadata {
  const registers = seed ?? new Map<number, Register>();
  const ensure = (index: number): Register => {
    let register = registers.get(index);
    if (!register) {
      register = { r: 0, g: 0, b: 0, defined: false, used: false };
      registers.set(index, register);
    }
    return register;
  };

  let x = 0;
  let bandY = 0;
  let maxX = -1;
  let maxY = -1;
  let declared: { width: number; height: number } | undefined;
  let current = 0;
  let i = start;

  const paint = (bits: number) => {
    const register = ensure(current);
    register.used = true;
    for (let bit = 0; bit < 6; bit++) {
      if ((bits & (1 << bit)) === 0) {
        continue;
      }
      const px = x;
      const py = bandY + bit;
      if (px > maxX) {
        maxX = px;
      }
      if (py > maxY) {
        maxY = py;
      }
      onPaint(px, py, register);
    }
  };

  const readNumber = (): number => {
    let text = '';
    while (i < end && isDigit(bytes[i])) {
      text += String.fromCharCode(bytes[i]);
      i++;
    }
    return text.length > 0 ? parseInt(text, 10) : 0;
  };

  while (i < end) {
    const byte = bytes[i];
    if (byte === 0x23) {
      // '#'
      i++;
      const index = readNumber();
      const register = ensure(index);
      const params: number[] = [];
      while (i < end && bytes[i] === 0x3b) {
        i++;
        params.push(readNumber());
      }
      if (params.length >= 4 && params[0] === 2) {
        register.r = clamp(Math.round((params[1] * 255) / 100), 0, 255);
        register.g = clamp(Math.round((params[2] * 255) / 100), 0, 255);
        register.b = clamp(Math.round((params[3] * 255) / 100), 0, 255);
        register.defined = true;
      } else if (params.length >= 4 && params[0] === 1) {
        const rgb = hlsToRgb(params[1], params[2], params[3]);
        register.r = rgb.r;
        register.g = rgb.g;
        register.b = rgb.b;
        register.defined = true;
      }
      current = index;
      continue;
    }

    if (byte === 0x21) {
      // '!'
      i++;
      const count = readNumber();
      if (i < end) {
        const data = bytes[i];
        i++;
        if (data >= 0x3f && data <= 0x7e) {
          const bits = data - 0x3f;
          for (let rep = 0; rep < count; rep++) {
            paint(bits);
            x++;
          }
        }
      }
      continue;
    }

    if (byte === 0x24) {
      // '$'
      x = 0;
      i++;
      continue;
    }

    if (byte === 0x2d) {
      // '-'
      x = 0;
      bandY += 6;
      i++;
      continue;
    }

    if (byte === 0x22) {
      // '"' raster attributes
      i++;
      const values: number[] = [];
      while (i < end && (isDigit(bytes[i]) || bytes[i] === 0x3b)) {
        if (bytes[i] === 0x3b) {
          i++;
          continue;
        }
        values.push(readNumber());
      }
      if (values.length >= 4) {
        declared = { width: values[2], height: values[3] };
      }
      continue;
    }

    if (byte >= 0x3f && byte <= 0x7e) {
      paint(byte - 0x3f);
      x++;
      i++;
      continue;
    }

    i++;
  }

  return { maxX, maxY, declared, registers };
}

export function decodeSixel(
  input: Uint8Array | string,
  options: SixelDecodeOptions = {}
): SixelDecodeResult {
  const bytes = toBytes(input);
  const { start, end } = locateBody(bytes);
  const maxPixels = options.maxPixels ?? MAX_IMAGE_PIXELS;

  const first = parseSixel(bytes, start, end, () => {});
  if (first.maxX < 0 || first.maxY < 0) {
    throw new Error('sixel stream painted no pixels');
  }

  const paintedWidth = first.maxX + 1;
  const paintedHeight = first.maxY + 1;
  const width = Math.max(paintedWidth, first.declared?.width ?? 0);
  const height = Math.max(paintedHeight, first.declared?.height ?? 0);
  if (width < 1 || height < 1) {
    throw new Error('sixel stream produced an empty canvas');
  }
  if (width * height > maxPixels) {
    throw new Error(`sixel canvas ${width}x${height} exceeds the maximum of ${maxPixels} pixels`);
  }

  const background = options.background ?? { r: 0, g: 0, b: 0, a: 0 };
  const image = createImage(width, height);
  if (background.a !== 0) {
    fillRect(image, { x: 0, y: 0, width, height }, background);
  }

  parseSixel(
    bytes,
    start,
    end,
    (px, py, register) => {
      setPixel(image, px, py, { r: register.r, g: register.g, b: register.b, a: 255 });
    },
    first.registers
  );

  const palette: SixelPaletteEntry[] = [];
  let coloursUsed = 0;
  const indices = [...first.registers.keys()].sort((a, b) => a - b);
  for (const index of indices) {
    const register = first.registers.get(index) as Register;
    if (register.used) {
      coloursUsed++;
    }
    if (register.defined || register.used) {
      palette.push({
        index,
        r: register.r,
        g: register.g,
        b: register.b,
        hex: formatColour({ r: register.r, g: register.g, b: register.b, a: 255 }),
      });
    }
  }

  return {
    width,
    height,
    bands: Math.ceil(height / 6),
    image,
    palette,
    coloursUsed,
    declared: first.declared,
  };
}
