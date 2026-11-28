# imagelab — image lab module

Pixel-level UI work on PNG files: six tools — `img_diff`, `img_sample`,
`img_crop_scale`, `img_compose`, `sixel_decode`, `contrast_check`. Compare
golden snapshots against renderings, derive pens from reference screenshots,
assemble comparison sheets, verify a Sixel encoder independently and score WCAG
contrast — without ever pulling an image into the context.

## What it is / why

Dev agents work blind on pixel output: a renderer produces bytes, a screenshot
lands on disk, and the agent can neither see nor compare it. `imagelab` closes
that gap with numbers instead of pixels — changed-pixel counts, bounding
regions, palette shares, contrast ratios — and writes every visual result to a
PNG file for a human to open.

It is a separate, independent module from `termlab` (#119): neither depends on
the other or on `core`. Consumers are four-sixel-lab #61 (Workbench gallery vs
the OS 3.9 reference), #55, the Second Reality port and turbo-tui pixel mode
(#34).

## Requirements

- Pure TypeScript on Bun. The PNG codec and the Sixel decoder live in
  `src/lib/imagelab/` over `node:zlib` — **no new dependency**.
- No network access; every tool works on local files.
- Images are always written to files, never returned into the context. Tool
  outputs are numbers, paths and palettes only.
- Every image and canvas is capped at **16M pixels** (16777216); larger
  dimensions fail with a clear error instead of exhausting memory.

## PNG support

Decoder (read):

- Colour types 0 (grey), 2 (truecolour), 3 (palette), 4 (grey+alpha),
  6 (truecolour+alpha).
- Bit depths 1/2/4/8/16 in the combinations the PNG spec allows (type 0:
  1/2/4/8/16, type 3: 1/2/4/8, types 2/4/6: 8/16). 16-bit samples are reduced
  to the high byte.
- All five row filters: None, Sub, Up, Average, Paeth.
- `tRNS` transparency for colour types 0/2/3; native alpha for types 4/6.
- CRC verification on every chunk. Unknown critical chunks are rejected;
  ancillary chunks are ignored — APNG extras (`acTL`, `fcTL`, `fdAT`) fall
  under that and the default (IDAT) image is used.
- No Adam7 interlace (`interlace != 0` is rejected). No ICC or gamma
  correction.

Encoder (write): always 8-bit RGBA (colour type 6), filter-0 rows, deflate via
`node:zlib`.

## Tool reference

### `img_diff`

Pixel-diff two PNG images and write a highlighted diff image. The colour delta
of a pixel is the maximum absolute difference over all four channels (R, G, B
**and** alpha); a pixel counts as changed when that delta exceeds `threshold`.
Changed pixels are painted `highlight`, unchanged pixels show the B image dimmed
by the `dim` factor (alpha forced opaque). Changed pixels are grouped into
4-connected regions (flood fill, no diagonal links), sorted by pixel count
(largest first) and capped by `maxRegions`. When `a` and `b` differ in size the
canvas is the bounding maximum of both; pixels outside an input are treated as
transparent for the delta computation and painted opaque black in the diff
image.

**Parameters:** `a`, `b` (string — PNG paths, required), `output` (string,
optional; default beside `a`: `<name>.diff.png`, or `<name>.compose.png` when
`sideBySide` is set), `threshold` (0…255, default 0), `maxRegions` (1…200,
default 20), `highlight` (string colour, default `#ff0044`), `dim` (0…1,
default 0.35), `sideBySide` (boolean, default `false`), `labels` (string[],
max 3), `directory` (string, optional).

**Output:** `a`, `b` (sizes), `canvas`, `changedPixels`, `totalPixels`,
`changedRatio`, `maxDelta`, `meanDelta`, `regions[]` (`x`, `y`, `width`,
`height`, `pixels`), `regionsTotal`, `truncated`, `diffImage` (path);
`sizeMismatch` when the inputs differ in size, `sideBySide: true` when set.

```jsonc
{ "a": "shots/before.png", "b": "shots/after.png", "threshold": 4, "maxRegions": 20,
  "sideBySide": true, "labels": ["REF", "RENDER", "DIFF"] }
```

### `img_sample`

Read pixel colours, region statistics and dominant palettes from a PNG image.
Dominant-colour palettes quantise every pixel to 5 bits per channel, count the
buckets and report the bucket's average colour with its `share` of the sampled
pixels and its raw `count`. Region statistics count exact RGBA values for
`uniqueColors` and average all channels for `mean`.

**Parameters:** `path` (string, required), `points` (array of `{x, y, label?}`,
max 256, optional), `regions` (array of `{x, y, width, height, label?}`, max 32,
optional), `palette` (object: `colors` 1…32, default 8, optional `region`
`{x, y, width, height}` — defaults to the whole image), `dominant` (1…16,
default 5 — dominant colours per region), `directory` (string, optional). At
least one of `points`, `regions`, `palette` must be given.

**Output:** `path`, `size`, `points[]` (`label?`, `x`, `y`, `hex`, `rgba`),
`regions[]` (`label?`, `x`, `y`, `width`, `height`, `uniqueColors`, `mean`,
`dominant[]`), `palette` (`region`, `sampled`, `colors[]` of `hex`, `share`,
`count`) when requested.

```jsonc
{ "path": "shots/screen.png",
  "points": [{ "x": 4, "y": 2, "label": "pen" }],
  "regions": [{ "x": 0, "y": 0, "width": 64, "height": 32, "label": "title" }],
  "palette": { "colors": 8 } }
```

### `img_crop_scale`

Crop a rectangular region from a PNG image and optionally scale it with integer
nearest-neighbour sampling (every source pixel becomes a `scale`×`scale`
block), then write the result.

**Parameters:** `path` (string, required), `region` (`{x, y, width, height}` —
defaults to the whole image), `scale` (integer 1…32, default 1), `output`
(string, optional; default beside the source: `<name>.crop.png`), `directory`
(string, optional).

**Output:** `path` (source), `source` (size), `region`, `scale`, `output`
(`path`, `width`, `height`).

```jsonc
{ "path": "shots/screen.png", "region": { "x": 8, "y": 8, "width": 32, "height": 16 }, "scale": 4 }
```

### `img_compose`

Compose 1..8 PNG images into a horizontal strip, vertical stack or grid. Each
panel is optionally scaled with integer nearest-neighbour sampling first, gets
an optional label rendered in a built-in 5×7 uppercase font (unsupported
characters render as `?`) in the `labelHeight` band above it, and is placed with
`gap` background pixels between panels. Label height is only reserved when at
least one input carries a label. Grid columns default to `ceil(sqrt(count))`
and cells are sized to the largest panel. Labels draw at panel origin + (2, 2)
in `#e6e6e6`; the canvas is filled with `background` first.

**Parameters:** `inputs` (array of `{path, label?}`, 1…8 — required), `layout`
(`horizontal` | `vertical` | `grid`, default `horizontal`), `columns` (1…8,
default `ceil(sqrt(count))`), `gap` (0…128, default 8), `background` (string
colour, default `#101010`), `labelHeight` (0…64, default 12), `labelScale`
(1…4, default 1), `scale` (1…16, default 1), `output` (string, optional;
default `imagelab-compose.png` in the base directory), `directory` (string,
optional).

**Output:** `output` (path), `width`, `height`, `layout`, `columns`, `gap`,
`labels` (whether any label was set), `panels[]` (`label?`, `x`, `y`, `width`,
`height`).

```jsonc
{ "inputs": [{ "path": "shots/a.png", "label": "A" }, { "path": "shots/b.png", "label": "B" }],
  "layout": "grid", "gap": 8, "scale": 2 }
```

### `sixel_decode`

Decode a Sixel image stream into a PNG. Input is a bare stream or a DCS-wrapped
one (`ESC P … q` … `ST`, 7-bit or 8-bit); the wrapper is located and stripped
automatically. The implemented subset: `#Pc;Pu;Px;Py;Pz` colour definitions
with RGB (`Pu=2`, components in percent) and HLS (`Pu=1`), `P1;P2;P3;P4`
raster attributes (`"` — the declared raster width/height are reported as
`declared`), `!Pn` repeats, `$` (return to the band start) and `-` (next band,
6 pixels down) controls, and sixel data characters `?`…`~`. Undefined colour
registers render black — there are no terminal-side palette defaults. The
canvas is the maximum of the painted extent and the declared raster size;
`bands` is `ceil(height/6)`.

**Parameters:** `path`/`data` (string — exactly one required; `path` reads a
file, `data` is the inline stream), `output` (string, optional; default beside
the source: `<name>.decoded.png`, or `sixel-decoded.png` for inline data),
`background` (string colour, optional — filled behind the decoded image;
default transparent), `directory` (string, optional).

**Output:** `size`, `bands`, `palette[]` (`index`, `r`, `g`, `b`, `hex` —
defined or used registers), `coloursUsed`, `output` (`path`, `width`,
`height`), `declared` (`width`, `height`) when the stream carries raster
attributes.

```jsonc
{ "path": "shots/capture.sixel", "background": "#000000" }
```

### `contrast_check`

Check WCAG 2.x contrast ratios for explicit foreground/background colour pairs
and/or pairs extracted from a JSON skin or theme file. Extraction walks the JSON
(depth ≤ 8, max 200 pairs) and pairs every foreground key (`fg`, `foreground`,
`text`, `textcolor`, `textcolour`, `colour`, `color`, `pen`, `ink`, `primary`)
with a background key (`bg`, `background`, `back`, `paper`, `surface`,
`backgroundcolor`, `backgroundcolour`) from the same object, falling back to the
`background` argument. Ratios composite a translucent foreground over its
background first, then compare relative luminances. Thresholds: `aa` ≥ 4.5,
`aaa` ≥ 7, `largeTextAa` ≥ 3, `largeTextAaa` ≥ 4.5.

**Parameters:** `pairs` (array of `{label?, foreground, background}`, max 200,
optional), `skin` (string path to a JSON file, optional), `background` (string
colour, default `#000000` — fallback for extracted pairs), `directory` (string,
optional). At least one of `pairs`, `skin` must be given.

**Output:** `total`, `failed` (entries failing `aa`), `pairs[]` (`label?`,
`foreground`, `background`, `ratio`, `aa`, `aaa`, `largeTextAa`,
`largeTextAaa`).

```jsonc
{ "pairs": [{ "label": "prompt", "foreground": "#e6e6e6", "background": "#101010" }],
  "skin": "themes/dark.json", "background": "#000000" }
```

## Detection and module selection

Auto mode is conservative: `imagelab` is only enabled when golden PNG snapshots
are detected in the project directory or worktree. Otherwise the module is
opt-in via `"modules": ["imagelab"]` in `opencode.json`. The module has no
dependencies — not on `termlab`, not on `core` (beyond the always-present core
bundle) — and adds nothing to other modules.

Golden snapshot detection (`src/lib/imagelab/detect.ts`) is bounded:

- a directory named `snapshot`, `snapshots`, `__snapshot__`, `__snapshots__`,
  `golden` or `goldens` (case-insensitive) containing a `.png` file, or
- a `*.golden.png`, `*.snap.png` or `*.expected.png` file (case-insensitive)
  within depth 3.

Skipped: `node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`,
`tmp`, `var` and all dot-directories (`.git`, `.next`, `.cache`, `.venv`, …);
the walk visits at most 200 directories.

## Fixtures and tests

- `tests/fixtures/imagelab/sample.sixel` — 6x12 image, 2 bands, registers
  0 black / 1 red / 2 green, with raster attributes.
- One test file per tool plus library tests (PNG codec, diff/regions, palette
  quantisation, compose/font, Sixel parser, contrast, snapshot detection).
- Gates: `bun test` (715 pass, 3 skip), `bun run typecheck`, `bun run lint`.

## Limitations

- No Adam7 interlace — interlaced PNGs are rejected, not partially decoded.
- No perceptual ΔE: the diff colour delta is the per-channel maximum (including
  alpha), so a hue shift can be as loud as a brightness shift of the same
  magnitude.
- Sixel: no scrolling, pan or zoom semantics; no terminal-side palette defaults
  (undefined registers are black); the decoder covers the common encoder
  output, not every DEC extension.
- The label font is uppercase ASCII only (plus digits and a few punctuation
  marks); anything else renders as `?`.
- Images are memory-bounded (16M pixels per image/canvas), not streamed; very
  large comparisons must be split by hand.
