# four-opencode-supertools

[![npm](https://img.shields.io/npm/v/@four-bytes/four-opencode-supertools)](https://www.npmjs.com/package/@four-bytes/four-opencode-supertools)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)

Token-efficient supertools for opencode agents. Each tool saves significant tokens by replacing multi-step workflows with single, optimized calls.

## Tools

The plugin registers up to **35 tools**, grouped into selectable modules (see
[Modules](#modules)). The default `"modules": "auto"` registers every tool that
applies to the project — 23 for a Symfony PHP project, plus 6 Terminal Lab tools
when a TUI is detected and 6 Image Lab tools when golden PNG snapshots are
detected (or via explicit `"modules": ["imagelab"]`). This table mirrors the
authoritative tool stack in [AGENTS.md](AGENTS.md).

### File Editing (4)

| Tool              | Token Savings | Description                                          |
| ----------------- | ------------- | ---------------------------------------------------- |
| **`batch_edit`**  | ~80%          | Search and replace across multiple files in one call |
| **`append_file`** | ~95%          | Append or prepend text to a file                     |
| **`lint_file`**   | ~60%          | Run linter (ESLint/tsc/Deno/PHP/Go/Rust) on a file, errors only |
| **`run_tests`**   | ~50%          | Run a test file (Bun/Vitest/Jest/PHPUnit/Go/Cargo/Deno), failures only |

### Smart Editing (3)

| Tool              | Description                                                      |
| ----------------- | ---------------------------------------------------------------- |
| **`smart_edit`**  | Fuzzy string replace with whitespace tolerance                   |
| **`smart_patch`** | Context-anchored patch ignoring line numbers                     |
| **`batch_patch`** | Multi-file patch in one call, optional atomic mode with rollback |

### Meta-Tools (2)

| Tool                      | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| **`file_tree`**           | Structured directory listing with sizes (skips .git/node_modules/vendor) |
| **`solution_confidence`** | Score a fix by running the test suite + git blast-radius check directly  |

### Search (1)

| Tool               | Description                                        |
| ------------------ | -------------------------------------------------- |
| **`sonar_search`** | Perplexity Sonar web search — answer + citations   |

### LSP / Structure (4)

| Tool                  | Token Savings | Description                                                                  |
| --------------------- | ------------- | ---------------------------------------------------------------------------- |
| **`file_outline`**    | ~95%          | Structure-only outline (symbols + line numbers), never file bodies            |
| **`lsp_hover`**       | ~95%          | Type info and documentation for a symbol at a position                       |
| **`lsp_references`**  | ~90%          | Find all references to a symbol at a position                                 |
| **`lsp_code_action`** | ~85%          | List/apply code actions for a range (extract, stub methods, organize imports) |

The LSP registry resolves each server's project root from markers (nearest `tsconfig.json`/`package.json`, `deno.json(c)`, `go.work` before `go.mod`, `composer.json`, and the outermost Cargo `[workspace]`), pools one client per server and canonical root, and shuts idle clients down after 10 minutes. Deno projects use `deno lsp`; `.supertools.json` accepts `lsp.servers` overrides and `lsp.idleTimeoutMs` (negative disables idle shutdown).

`lsp_code_action` is language-agnostic and prints one line per action. Typical kinds: Go — `refactor.extract.function`/`.variable` and `quickfix` stub methods; Rust — `refactor.extract.function` and fill match arms; TypeScript/JavaScript — `refactor.extract.function`/`.constant` and `source.organizeImports`. Apply with `index`, exact `title` or exact `kind`; `dryRun` returns the diff summary without writing.

### Symfony (3)

| Tool                | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| **`symfony_service`** | Service by id/class/partial/tag: class, arguments, tags, decorator chain |
| **`symfony_events`**  | Event listeners sorted by priority (`class::method prio`)                |
| **`twig_blocks`**     | Twig override chain for a block/template with `path:line`                |

All three call `bin/console` (`debug:container` / `debug:event-dispatcher` /
`debug:twig` with `--format=json`) and fall back to static config with
`source: "static", incomplete: true` when the console cannot run.

### Shopware (2)

| Tool             | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| **`sw6_plugin`** | Plugin state/load order, what a plugin registers, and the lifecycle sequence |
| **`sw6_theme`**  | Theme hierarchy, resolved view chain + assets, and `theme:compile` with SCSS errors |

### Terminal Lab (6)

| Tool                | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| **`term_run`**      | Headless tmux session: send text/keys/SGR mouse steps, capture changed rows with attribute runs           |
| **`trace_decode`**  | Decode a turbo-tui `TURBO_TUI_TRACE` v1 into one compact op line per terminal operation, per frame        |
| **`trace_replay`**  | Replay frames through an independent tmux emulator, diff against the recorded back buffer and modifiers   |
| **`cell_history`**  | Ordered writes per screen cell over a trace (character, modifiers, link) — no tmux needed                  |
| **`width_check`**   | Grapheme display width under unicode-width, wcwidth and a tmux emulator model, disagreements flagged      |
| **`term_checksum`** | DECRQCRA-style checksum: screen dump or trace frame, plus query/parse of DECRQCRA/DECCKSR sequences       |

### Image Lab (6)

| Tool                 | Description                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| **`img_diff`**       | Pixel-diff two PNGs: changed pixels, deltas and regions, highlighted diff image, optional side-by-side    |
| **`img_sample`**     | Pixel colours, region statistics and dominant palettes from a PNG image                                  |
| **`img_crop_scale`** | Crop a region from a PNG and scale it with integer nearest-neighbour sampling                            |
| **`img_compose`**    | Compose 1..8 PNGs into a strip, stack or grid with labels, gaps, background and pixel scaling            |
| **`sixel_decode`**   | Decode a bare or DCS-wrapped Sixel stream to PNG; reports bands, palette and declared raster size        |
| **`contrast_check`** | WCAG 2.x contrast ratios for colour pairs and skin/theme JSON keys, with AA/AAA and large-text flags     |

### AST / Refactoring (4)

| Tool                | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **`extract_method`** | Extract complete statements into a new method; rejects unsupported data/control-flow cases    |
| **`rename_symbol`**  | Rename a symbol: PHP structural (one file) / Go·Rust·TS·JS via LSP, applied atomically |
| **`move_class`**     | Move a class-like declaration, preserving declare blocks and referenced `use` imports         |
| **`change_route_path`** | Rewrite `#[Route()]` path arguments project-wide, exact match only, preview writes nothing |

> `extract_method` and the PHP `rename_symbol` path are **pure**: they return the
> generated content and never write to disk. The LSP `rename_symbol` path applies the
> server's `WorkspaceEdit` atomically (with rollback on failure). Git, GitHub and
> GitLab tools live in the separate `four-opencode-git` plugin.

### `batch_edit`

Search and replace across multiple files matching a glob pattern.

**Parameters:**

- `search` (string) — Regex pattern to find
- `replace` (string) — Replacement text ($1, $2 for capture groups)
- `glob` (string) — File pattern (e.g., `src/**/*.ts`)
- `path` (string, optional) — Base directory
- `dry_run` (boolean, optional) — Preview without writing

### `lint_file`

Run appropriate linter on a file and return only errors/warnings. For `.go` files golangci-lint (v2) lints the file's package from the nearest `go.mod`; `govet` and `staticcheck` are part of its standard set. For `.rs` files `cargo clippy --all-targets` lints the crate including tests, benches and examples from the nearest `Cargo.toml`; diagnostic paths are normalised against the Cargo workspace root and filtered to the exact file (no basename matching). For `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files ESLint runs, or `deno lint --json` + `deno check` in a Deno project (`deno.json`/`deno.jsonc`); `typecheck: true` additionally runs `tsc --noEmit -p <nearest tsconfig>` and merges the file's diagnostics with the linter output (`linter: "tsc"` runs only the type-check).

**Parameters:**

- `file_path` (string) — File to lint
- `linter` (string, optional) — `eslint`, `phpstan`, `pint`, `ruff`, `golangci`, `clippy`, `tsc`, `deno`, or `auto`
- `typecheck` (boolean, optional) — Run `tsc --noEmit` for TS/JS files in addition to the linter; ignored for Deno projects

### `run_tests`

Run tests for a specific file and return only failures. In a Go module (`go.mod` in the project directory) it runs `go test` on the package of the given `_test.go` file. In a Cargo crate it runs `cargo test` for `.rs` / `tests/*.rs` files. In a Deno project (`deno.json`/`deno.jsonc`) it runs `deno test` before the Bun/package.json fallback.

**Parameters:**

- `test_file` (string) — Test file to run
- `filter` (string, optional) — Test name pattern
- `framework` (string, optional) — `bun`, `phpunit`, `jest`, `vitest`, `go`, `cargo`, `deno`, or `auto`

### `sonar_search`

Web search via Perplexity Sonar using your own account — no Exa rate limits.
Returns a concise answer plus citation URLs.

**Parameters:**

- `query` (string) — The search query
- `model` (string, optional) — `sonar` (fast, default) or `sonar-pro` (deeper)
- `max_tokens` (number, optional) — Max answer tokens (default `1000`)

**Authentication:** resolved in order — `PERPLEXITY_API_KEY` environment variable,
then the `perplexity.key` entry in opencode's `auth.json`
(`$XDG_DATA_HOME/opencode/auth.json`, defaulting to `~/.local/share/opencode/auth.json`).

### `file_outline`

Return a structure-only outline of a file — symbol names, kinds and 1-based line
numbers. **Never returns file contents.** The primary path is the LSP
`textDocument/documentSymbol` request; if no language server answers (plain config
files, unsupported languages, timeout) it falls back to a regex scan of top-level
declarations and marks the header with ` [regex fallback]`.

```
## src/Four/Fulfillment/InvoiceViews.php (284 lines)
- class InvoiceViews (L18)
  - fn getViews() (L42)
  - fn buildFilter($key) (L156)
- const DEFAULT_GROUP (L14)
```

An empty or unreadable file renders as exactly `## <path> (0 lines)`. If the outline
would exceed ~100 lines across the batch, it is truncated and `… (N more symbols)` is
appended.

**Parameters:**

- `path` (string) — File to outline (absolute or relative to the project directory)
- `paths` (string[], optional) — Additional files to outline in the same call (batch)
- `max_depth` (number, optional) — Maximum nesting depth to include (default: `2`)

### `symfony_service`

Look up a Symfony service by id, FQCN, partial id or `tag:<name>`. Returns class,
arguments, tags, alias and decorator chain. Runtime data comes from
`bin/console debug:container --format=json`; without a working console the tool
reads `config/services.(yaml|yml|xml)` and marks the result
`source: "static", incomplete: true`.

**Parameters:** `service` (string, optional), `tag` (string, optional),
`limit` (number, default 20), `directory` (string, optional).

### `symfony_events`

List listeners for an event, sorted by priority. Runtime data comes from
`bin/console debug:event-dispatcher --format=json`; the static fallback uses
`kernel.event_listener` tags and `getSubscribedEvents()` and is marked
`incomplete`.

**Parameters:** `event` (string), `limit` (number, default 50),
`directory` (string, optional).

### `twig_blocks`

Show the Twig override chain for a block name or outline a template and its
`extends` chain. Runtime data comes from
`bin/console debug:twig --format=json`; without a working console the loader paths
and namespaces come from `config/packages/twig.(yaml|yml)` and the result is marked
`incomplete`.

- `mode: "block"` collects every `{% block <name> %}` definition, ordered
  base → derived using the `extends` graph. `parentCall` reports whether the block
  body calls `parent()`.
- `mode: "template"` scans one template plus its ancestors and returns the extends
  chain, block definitions, `use`/`embed`/`include` references and unknown tags.
- Custom inheritance tags are auto-detected from project Twig extensions: a
  `getTokenParsers()` token parser that extends `ExtendsTokenParser`,
  `IncludeTokenParser`, `EmbedTokenParser`, `UseTokenParser` or `BlockTokenParser`
  is mapped to that built-in semantic. Unmapped tags stay unknown and carry a
  hint to map them under `twig.tags`.
- A `templates/bundles/<Bundle>/` override wins over the bundle base for
  `@Bundle/...` names.
- In a Shopware project (with the `shopware` module active) a Storefront adapter
  maps `sw_extends`/`sw_include`/`sw_embed`/`sw_use` onto the built-in
  inheritance semantics and treats every other `sw_*` tag as known, so
  `{% sw_icon %}` is never reported as unknown. The effective view chain
  (storefront → plugins → theme, following theme parents) comes from the
  Shopware resolver instead of `debug:twig`.
- Without a theme/sales-channel filter every distinct theme yields its own chain.
  `theme` and `salesChannel` narrow the result to one chain; an unknown theme or
  an unassigned sales channel returns no chains together with the available theme
  names and an honest `incomplete` flag. Unknown tags are aggregated across
  chains.
- The scanner is tolerant: malformed tags and unknown tags are reported, never
  fatal. References resolve to `path:line`, never file contents.

**Parameters:** `mode` (`block` | `template`, default `block`), `name` (string),
`template` (string, optional — block mode scope), `limit` (number, default 50),
`directory` (string, optional), `theme` (string, optional — Shopware only, theme
name or technical name), `salesChannel` (string, optional — Shopware only, hex
sales channel id).

### `sw6_plugin`

Work with Shopware 6 plugins.

- `mode: "list"` reports every plugin in load order with version, active state,
  kind and theme detection.
- `mode: "overview"` lists what one plugin registers — services, scheduled tasks,
  subscribers, entities, migrations, admin modules and Twig overrides — with
  `path:line` references and never file contents. Theme plugins carry a pointer to
  `sw6_theme` for the storefront view chain.
- `mode: "lifecycle"` plans or runs the console sequence for `refresh`, `install`,
  `activate`, `deactivate`, `update` and `uninstall`, followed by `cache:clear`;
  theme state changes append `theme:compile`.
- Safety: lifecycle is a **dry run** unless `confirm: true`, and `uninstall` keeps
  user data by default (`--keep-user-data`) unless `keepUserData: false`.

**Parameters:** `mode` (`list` | `overview` | `lifecycle`, default `list`),
`plugin` (string, optional — required for `overview` and every lifecycle action
except `refresh`), `action` (`refresh` | `install` | `activate` | `deactivate` |
`update` | `uninstall`, optional — required in lifecycle mode), `confirm`
(boolean, default `false`), `keepUserData` (boolean, default `true`), `limit`
(number, default 50), `directory` (string, optional).

### `sw6_theme`

Work with Shopware 6 themes.

- `mode: "list"` reports the theme hierarchy with each theme's parent chain and
  sales-channel assignments; unresolved parents are reported honestly.
- `mode: "resolve"` returns the effective view chain plus the declared
  style/script assets (most-specific theme first, with `exists` flags and
  root-relative paths) for one theme. Give `theme` (name or technical name),
  or give only `salesChannel` to resolve the theme bound to that channel.
- `mode: "compile"` runs `theme:compile` (idempotent — no confirm gate). SCSS
  errors are returned as `path:line[:col] message` only, never raw console
  output; `salesChannel` adds `--only=<id>` (Shopware 6.5+).

**Parameters:** `mode` (`list` | `resolve` | `compile`, default `list`), `theme`
(string, optional — required for `resolve` unless `salesChannel` is given),
`salesChannel` (string, optional — hex id; `--only=<id>` for compile
(Shopware 6.5+), mapped theme for resolve), `limit` (number, default 50 — max
asset/error entries),
`timeoutMs` (number, optional — compile timeout, default 300000, clamped to
1000…900000), `directory` (string, optional).

The Terminal Lab tools operate on the turbo-tui trace format
(`TURBO_TUI_TRACE 1`, grammar in [docs/termlab.md](docs/termlab.md)). Record one
with `TURBO_TUI_TRACE=/tmp/demo.trace cargo run --example demo` in a turbo-tui
app. `term_run`, `trace_replay` and the `tmux` width model require **tmux**
(Linux/WSL); without it they return `available: false` with
`error: "tmux not found"` and a hint. The oracle is tmux only — an independent
VT implementation, not your terminal: terminal-specific rendering bugs of
Windows Terminal, Kitty or WezTerm cannot be reproduced.

### `term_run`

Drive a headless tmux session and capture the screen after each step. Steps send
literal text, named keys or SGR mouse events, then wait and capture only changed
rows — text plus coalesced attribute runs (`{from, to, style}`). Every run owns a
private tmux server and always kills it.

**Parameters:** `command` (string runs via the shell, array runs as argv),
`steps` (max 100; each step sets exactly one of `send`/`key`/`mouse`, or only
`wait`), `width` (default 120), `height` (default 40), `cwd`, `env`, `settleMs`
(default 120, clamped 0…5000), `timeoutMs` (default 20000, clamped
1000…300000), `attributes` (default `true`), `full` (default `false` — changed
rows only), `checksum` (default `false` — per-step DECRQCRA-style checksum),
`region` (default full screen), `directory` (string, optional).

```jsonc
{ "command": "cargo run --example demo",
  "steps": [{ "mouse": { "action": "press",   "x": 20, "y": 3 } },
            { "mouse": { "action": "drag",    "x": 26, "y": 6 } },
            { "mouse": { "action": "release", "x": 26, "y": 6 } }] }
```

### `trace_decode`

Decode a `TURBO_TUI_TRACE` v1 file into one compact line per terminal operation
(`MOVE`, `SGR`, `OSC8`, `TEXT`, `CLEAR`, …) per frame. Pure TypeScript, no tmux.

**Parameters:** `path` (string, optional — exactly one of `path`/`text`),
`text` (string, optional), `fromFrame`/`toFrame` (number, optional — inclusive
frame range), `region` (object, optional — only `TEXT`/`MOVE` ops whose cursor
lies inside), `limit` (number, default 200, cap 2000 ops per frame),
`directory` (string, optional).

```jsonc
{ "path": "/tmp/demo.trace", "fromFrame": 3, "toFrame": 5, "limit": 50 }
```

### `trace_replay`

Replay recorded frames through an independent tmux emulator and compare the
rendered screen against the recorded back buffer and modifier masks (colour is
never compared). `ok: true` with `matched: false` is data, not a failure: each
divergence carries `frame`, `x`, `y`, `expected`, `actual` and the frame bytes
as hex. Requires tmux.

**Parameters:** `path`/`text` (exactly one), `fromFrame`/`toFrame` (number,
optional), `settleMs` (default 60, clamped 0…5000), `timeoutMs` (default 60000,
clamped 1000…300000), `stopOnFirstDivergence` (default `true`), `limit` (number,
default 5, cap 100 divergences), `compareMods` (default `true`), `directory`
(string, optional).

```jsonc
{ "path": "/tmp/demo.trace", "stopOnFirstDivergence": true, "compareMods": true }
```

### `cell_history`

Reconstruct what every screen cell held over a trace — the ordered writes per
cell (character, modifier names and mask, OSC 8 link) — by simulating the
recorded byte stream. No tmux needed.

**Parameters:** `path`/`text` (exactly one), `x`/`y` (number, optional — one
cell; must be given together), `region` (object, optional), `fromFrame`/
`toFrame` (number, optional), `limit` (number, default 200 cells),
`writesPerCell` (number, default 50), `directory` (string, optional).

```jsonc
{ "path": "/tmp/demo.trace", "x": 12, "y": 2, "writesPerCell": 10 }
```

### `width_check`

Display width per grapheme cluster under `unicode` (unicode-width model),
`wcwidth` and an independent `tmux` emulator model. Reports where the selected
models disagree, so width assumptions can be settled with evidence.

**Parameters:** `text` (string — required), `models` (array of `unicode`,
`wcwidth`, `tmux`; default `["unicode", "wcwidth"]`), `plain` (boolean, default
`false` — drops codepoints and differs flags). The `tmux` model needs tmux and
reports `tmux: { available: false }` when it is missing.

```jsonc
{ "text": "— ❤️", "models": ["unicode", "wcwidth", "tmux"] }
```

### `term_checksum`

DECRQCRA-style checksum (`utf16-sum-mod-65536`). `compute` checksums a text
screen dump, `trace` a trace frame back buffer, `query` emits the DECRQCRA
request `CSI Pid;Pp;Pt;Pl;Pb;Pr*y`, and `parse` reads a DECCKSR response
(`DCS Pid!~hhhh ST` or `CSI Pid;value*y`). Both `compute` and `trace` use the
same algorithm: the sum of the UTF-16 code units of every cell, modulo 65536 —
attributes are never included. Windows Terminal implements DECRQCRA, but its
exact behaviour must be validated once by the user against the build in use.

**Parameters:** `mode` (`compute` | `trace` | `query` | `parse`, default
`compute`), `text` (string — `compute`), `path` (string — `trace`), `frame`
(number, default 1), `response` (string — `parse`), `region` (object;
required for `query`), `page` (number, default 1), `id` (number, default 1),
`directory` (string, optional).

```jsonc
{ "mode": "trace", "path": "/tmp/demo.trace", "frame": 1 }
```

The Image Lab tools do pixel-level UI work on PNG files: compare golden snapshots
against renderings, derive pens from reference screenshots and verify a Sixel
encoder independently. Images are always written to files — the values returned
to context are numbers, paths and palettes only. Primary consumers are
four-sixel-lab #61 (Workbench gallery vs the OS 3.9 reference), #55, the Second
Reality port and turbo-tui pixel mode #34. The PNG codec and Sixel decoder are
pure TypeScript over `node:zlib` — no new dependency — and every image or canvas
is capped at 16M pixels. Full details in [docs/imagelab.md](docs/imagelab.md).

### `img_diff`

Pixel-diff two PNG images and write a highlighted diff image. A pixel counts as
changed when the maximum absolute per-channel delta (R, G, B and alpha) exceeds
`threshold`. Changed pixels are painted `highlight`, unchanged pixels show the B
image dimmed by `dim`. Changed pixels are grouped into 4-connected regions
(largest first), capped by `maxRegions`; `regionsTotal` and `truncated` report
when more were found. When the sizes differ the canvas is the bounding maximum
of both; pixels outside an input are treated as transparent for the delta
computation and painted opaque black in the diff image (`sizeMismatch` is
reported). `sideBySide` additionally writes a horizontal A│B│DIFF composite
(gap 8, labels default `A`, `B`, `DIFF`).

**Parameters:** `a`, `b` (string, PNG paths — required), `output` (string,
optional — default beside `a`: `<name>.diff.png`, or `<name>.compose.png` with
`sideBySide`), `threshold` (number 0…255, default 0), `maxRegions` (number
1…200, default 20), `highlight` (string, default `#ff0044`), `dim` (number 0…1,
default 0.35), `sideBySide` (boolean, default `false`), `labels` (string[],
max 3), `directory` (string, optional). Output carries the `a`/`b` sizes,
`canvas`, `changedPixels`, `totalPixels`, `changedRatio`, `maxDelta`, `meanDelta`,
`regions` (`x`, `y`, `width`, `height`, `pixels`), `regionsTotal`, `truncated`
and the `diffImage` path.

```jsonc
{ "a": "shots/before.png", "b": "shots/after.png", "threshold": 4,
  "sideBySide": true, "labels": ["REF", "RENDER", "DIFF"] }
```

### `img_sample`

Read pixel colours, region statistics and dominant palettes from a PNG image.
Points report `hex` and `rgba`; regions report `uniqueColors`, the `mean` colour
and `dominant` colours; a `palette` request returns the dominant colours of the
whole image or one region with `share` and `count` each. Dominant colours are
bucketed by 5 bits per channel and averaged per bucket.

**Parameters:** `path` (string, required), `points` (array of `{x, y, label?}`,
max 256, optional), `regions` (array of `{x, y, width, height, label?}`, max 32,
optional), `palette` (object — `colors` 1…32, default 8, optional `region`;
defaults to the whole image), `dominant` (number 1…16, default 5 — dominant
colours per region), `directory` (string, optional). At least one of `points`,
`regions`, `palette` is required.

```jsonc
{ "path": "shots/screen.png",
  "points": [{ "x": 4, "y": 2, "label": "pen" }],
  "regions": [{ "x": 0, "y": 0, "width": 64, "height": 32, "label": "title" }],
  "palette": { "colors": 8 } }
```

### `img_crop_scale`

Crop a rectangular region from a PNG image and optionally scale it with integer
nearest-neighbour sampling, then write the result.

**Parameters:** `path` (string, required), `region` (`{x, y, width, height}` —
defaults to the whole image), `scale` (number, integer 1…32, default 1), `output`
(string, optional — default beside the source: `<name>.crop.png`), `directory`
(string, optional).

```jsonc
{ "path": "shots/screen.png", "region": { "x": 8, "y": 8, "width": 32, "height": 16 }, "scale": 4 }
```

### `img_compose`

Compose 1..8 PNG images into a horizontal strip, vertical stack or grid, with
optional labels above each panel, a gap, background colour and integer
nearest-neighbour scaling of every panel. Labels use a built-in 5x7 uppercase
font (unsupported characters render as `?`) and reserve `labelHeight` pixels
above their panel (only when at least one label is set). Grid columns default to
`ceil(sqrt(count))`. Output defaults to `imagelab-compose.png` in the base
directory.

**Parameters:** `inputs` (array of `{path, label?}`, 1…8 — required), `layout`
(`horizontal` | `vertical` | `grid`, default `horizontal`), `columns` (number
1…8, default `ceil(sqrt(count))`), `gap` (number 0…128, default 8), `background`
(string, default `#101010`), `labelHeight` (number 0…64, default 12),
`labelScale` (number 1…4, default 1), `scale` (number 1…16, default 1), `output`
(string, optional), `directory` (string, optional).

```jsonc
{ "inputs": [{ "path": "shots/a.png", "label": "A" }, { "path": "shots/b.png", "label": "B" }],
  "layout": "horizontal", "gap": 8, "scale": 2 }
```

### `sixel_decode`

Decode a Sixel image stream into a PNG, from a file or inline data. Accepts a
bare stream or a DCS-wrapped one (`ESC P … q` … `ST`). Supports `#` colour
definitions with RGB (`Pu=2`, percentages) and HLS (`Pu=1`), `!` repeats, `$`
(return to the band start) and `-` (next band) controls, and `"` raster
attributes — the declared raster size is reported as `declared`, and the canvas
is the maximum of painted and declared size. Undefined colour registers render
black. Reports `size`, `bands` (height/6), `palette` (register index plus
r/g/b/hex) and `coloursUsed`.

**Parameters:** `path`/`data` (string — exactly one required), `output` (string,
optional — default beside the source: `<name>.decoded.png`, or
`sixel-decoded.png` for inline data), `background` (string, optional — fill
behind the decoded image; default transparent), `directory` (string, optional).

```jsonc
{ "path": "shots/capture.sixel", "background": "#000000" }
```

### `contrast_check`

Check WCAG 2.x contrast ratios for explicit foreground/background pairs and/or
pairs extracted from a JSON skin or theme file. Extraction walks the JSON for
foreground keys (`fg`, `foreground`, `text`, `textcolor`, `textcolour`, `colour`,
`color`, `pen`, `ink`, `primary`) paired with a background key (`bg`,
`background`, `back`, `paper`, `surface`, `backgroundcolor`,
`backgroundcolour`) in the same object, falling back to the `background`
argument. Each entry reports `ratio` and pass flags: `aa` (≥ 4.5), `aaa` (≥ 7),
`largeTextAa` (≥ 3), `largeTextAaa` (≥ 4.5).

**Parameters:** `pairs` (array of `{label?, foreground, background}`, max 200,
optional), `skin` (string path to a JSON skin/theme file, optional), `background`
(string, default `#000000` — fallback for extracted pairs), `directory` (string,
optional). At least one of `pairs`, `skin` is required.

```jsonc
{ "pairs": [{ "label": "prompt", "foreground": "#e6e6e6", "background": "#101010" }],
  "skin": "themes/dark.json" }
```

### `extract_method`

Extract complete statements from a PHP method into a new method using tree-sitter.

The selection must align with complete statements inside one block. The extracted
method receives every pre-existing variable it reads as an untyped by-reference
parameter, so in-place mutations of caller variables keep working; the call site
passes them back. Static methods use `self::` and a `static` signature.

**Rejected loudly (no silent wrong edit):** partial statements, selections spanning
block boundaries, `return`/`yield`/`goto`, `break`/`continue` that jump out of the
selection (including depth-qualified `break 2`/`continue 2`), `$this` inside a static
method, values assigned in the selection and read afterwards, context-dependent magic
constants (`__METHOD__`, `__FUNCTION__`, `__LINE__`), and method-name collisions.
Collisions are compared case-insensitively, matching PHP method-name rules.

**Parameters:**

- `filePath` (string) — Absolute PHP file path
- `startLine` / `endLine` (number) — 1-based inclusive statement range
- `newMethodName` (string) — Valid PHP method name
- `visibility` (`private` | `protected` | `public`, optional) — Default `private`

### `rename_symbol`

Rename a symbol; the path depends on the file extension.

- `.php` — a declaration and provably same-scope references in **one file**. The
  matching is structural (tree-sitter), with optional line targeting. It is **not**
  semantic cross-file reference resolution: imports and references in other files are
  not updated and a warning says so.
  - Same-class `$this->`, `self::` and `static::` usages are renamed by default.
  - Class/interface/trait/function renames honour `renameUsages: false` too: only the
    declaration changes, and a warning reports the skipped usages.
  - "Provably same-scope" is structural, not semantic: a nested anonymous class is its
    own scope, and same-name members on other objects/classes are counted and reported
    as warnings.
  - Duplicate declarations of the same name are ambiguous: pass `line` to select one.
  - Variable renames require `line` — variables are scope-bound and file-wide matching
    would rename unrelated functions.
  - Free-function renames only update call sites in this file; calls in other files are
    not resolved.
- Go, Rust, TypeScript/JavaScript and any other language with a registered LSP server —
  `textDocument/prepareRename` + `textDocument/rename`, applied as a `WorkspaceEdit`
  atomically (all files or none). Requires the `lsp` module and the matching language
  module (`go`, `rust`, `typescript`). The target position comes from `line` + `column`,
  or `line` + the first `oldName` on it, or the first file occurrence.

**Parameters:**

- `filePath` (string) — Absolute file path
- `oldName` / `newName` (string) — Existing symbol name (leading `$` allowed for PHP
  variables) and the new identifier
- `symbolKind` (string, optional) — PHP only: `class`, `method`, `function`, `variable`,
  `interface`, `trait`, `property` or `constant`
- `line` (number, optional) — 1-based line inside the declaration/target to disambiguate
- `column` (number, optional) — 1-based column hint (requires `line`)
- `preview` (boolean, optional) — PHP: return changes without modified content; LSP: dry run
- `renameUsages` (boolean, optional) — PHP only; default `true`; `false` leaves
  same-scope usages unchanged and reports them as warnings
- `dry_run` (boolean, optional) — LSP path only: compute the edits without writing any file

### `move_class`

Move a class, interface, trait or enum to another file using tree-sitter.

- The source `declare(...)` block is copied verbatim; `strict_types` is never
  injected or upgraded.
- Referenced `use` statements are copied to the target file (unused imports are not).
- The target namespace comes from an explicit `namespace` argument or the nearest
  `composer.json` PSR-4 mapping (`autoload` / `autoload-dev`). If neither yields a
  unique namespace, the operation fails instead of guessing.
- Only top-level class-like declarations are movable; a class declared inside a
  function or conditional is not found and the operation fails.
- An empty PSR-4 prefix maps to the global namespace and does not produce a leading
  backslash. An explicit `namespace: ''` means "global namespace".
- Unresolved short class names that are neither imported nor built in are reported
  as warnings (after a namespace move they would resolve against the new namespace).
- A non-empty target file is never overwritten.

**Parameters:**

- `sourcePath` (string) — Absolute path to the current PHP file
- `className` (string) — Class-like name to move
- `targetPath` (string) — Target PHP file path (absolute or relative to cwd)
- `namespace` (string, optional) — Explicit target namespace

### `change_route_path`

Rewrite the path argument of `#[Route()]` attributes across the project using
tree-sitter.

- AST-based: only `attribute` nodes named `Route` (or ending in `\Route`, e.g. the
  FQCN `#[\Symfony\Component\Routing\Attribute\Route(...)]`) are inspected.
- Only the path argument is rewritten — the first positional argument or a named
  `path:` argument. Single- and double-quoted literals keep their quote style;
  only the characters between the quotes are replaced.
- The value must equal `oldPath` **exactly**. Nothing else changes: no other
  strings, comments, docblocks, method names or attribute arguments.
- A project-wide recursive scan is the point of the tool. It skips `.git`,
  `node_modules`, `vendor`, `var/cache` and `.idea`, inspects `.php` files and is
  bounded by `maxFiles`; an optional explicit `files` list replaces the scan.
- Zero matches is a normal no-op success. Each modified file is re-parsed before
  it is written; a file that cannot be parsed is reported in `failedFiles` and
  left untouched.
- `preview: true` reports changes and writes nothing.

**Parameters:**

- `oldPath` (string) — Exact route path to replace (e.g. `/api/orders`)
- `newPath` (string) — Replacement route path
- `directory` (string, optional) — Scan root; defaults to the tool context directory
- `files` (string[], optional) — Explicit files (absolute or relative to the scan
  root); skips the scan
- `maxFiles` (number, optional) — Cap on scanned PHP files, default `500`
- `preview` (boolean, optional) — Report changes without writing, default `false`

## Modules

Tools are grouped into modules that are selected per project. Configure them in
`opencode.json`:

```json
["@four-bytes/four-opencode-supertools", { "modules": "auto" }]
["@four-bytes/four-opencode-supertools", { "modules": ["core", "lsp", "shopware"] }]
["@four-bytes/four-opencode-supertools", { "disable": ["sonar_search"] }]
```

| Module     | Tools                                         | Auto-detected by                       |
| ---------- | --------------------------------------------- | -------------------------------------- |
| `core`     | 9 file-editing and meta tools                 | always on                              |
| `search`   | `sonar_search`                                | always on in auto mode                 |
| `lsp`      | `file_outline`, `lsp_hover`, `lsp_references`, `lsp_code_action` | always on in auto mode |
| `typescript` | `rename_symbol` (via LSP; tsc/Deno support lives in `lint_file`/`run_tests`) | `tsconfig.json`, `package.json`, `deno.json(c)` |
| `php`      | `extract_method`, `rename_symbol`, `move_class`, `change_route_path` | `composer.json`                      |
| `go`       | `rename_symbol` (via LSP)                     | `go.mod`                               |
| `rust`     | `rename_symbol` (via LSP)                     | `Cargo.toml`                           |
| `symfony`  | `symfony_service`, `symfony_events`, `twig_blocks` | `symfony/framework-bundle` in composer |
| `doctrine` | (later issue)                                 | `doctrine/orm` in composer             |
| `shopware` | `sw6_plugin`, `sw6_theme`                     | `shopware/core` in composer            |
| `termlab`  | `term_run`, `trace_decode`, `trace_replay`, `cell_history`, `width_check`, `term_checksum` | TUI dependency or `examples/` (Rust/TS/Go) |
| `imagelab` | `img_diff`, `img_sample`, `img_crop_scale`, `img_compose`, `sixel_decode`, `contrast_check` | golden PNG snapshots (`snapshots`/`golden`, `*.golden.png`) |

Auto mode always starts with `core`, `search` and `lsp`, then adds `typescript`,
`php`, `go`, `rust`, `symfony`, `doctrine`, `shopware`, `termlab` and `imagelab`
when their marker is present in the project directory or worktree. For the
framework markers, `composer.json` means the `require` or `require-dev` section
names the package; a shopware project also counts as symfony and PHP. `termlab`
is auto-detected for Rust, TypeScript or Go projects with a TUI dependency —
`ratatui`, `ratatui-core`, `crossterm`, `termion`, `cursive`, `notcurses`
(Rust); `ink`, `blessed`, `neo-blessed`, `terminal-kit`, `@opentui/*`
(TypeScript); `bubbletea`, `tcell`, `tview`, `termbox-go`, `gocui` (Go) — or an
`examples/` directory next to `Cargo.toml`, `go.mod` or a TS marker. It has no
module dependencies and is also selectable explicitly via
`"modules": ["termlab"]`. `imagelab` is an independent module with no
dependencies (neither on `termlab` nor on the other bundles) and is only added
in auto mode when golden PNG snapshots are detected — a directory named
`snapshot`, `snapshots`, `__snapshot__`, `__snapshots__`, `golden` or `goldens`
holding a `.png` file, or a `*.golden.png`/`*.snap.png`/`*.expected.png` file
within depth 3 (dependency, build and dot-directories are skipped). Otherwise
select it explicitly via `"modules": ["imagelab"]`.

Dependencies are resolved transitively: `typescript`, `go` and `rust` require
`lsp`, `symfony` requires `php`, `doctrine` and `shopware` require `symfony`.
`core` is always included, whatever list you pass. `disable` removes individual
tool names after the modules are merged.

To filter tools for a single agent, use opencode's own `tools` config instead of
`disable` — module selection is per project, agent filtering is per agent.

## .supertools.json

Per-project configuration for the framework tools lives in `.supertools.json` at
the project root (the directory holding `composer.json`). The file is optional;
without it the tools use their defaults. It is read per project root and cached
for the process lifetime.

```json
{
  "twig": {
    "tags": {
      "my_tag": "block",
      "another_tag": "include"
    },
    "discovery": {
      "vendor": false,
      "maxFiles": 3000
    }
  }
}
```

`twig.tags` maps a Twig tag name to its kind and overrides auto-detection.
Unknown keys are ignored for forward compatibility. Invalid schemas are reported
with the offending key (for example `twig.tags.my_tag`) and are never silently
dropped. `twig.discovery` controls auto-detection: `vendor` also scans
`<root>/vendor` (default `false`) and `maxFiles` caps the inspected PHP files
(default `3000`). This file is the config base for the Symfony/Shopware tools.

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["file:///home/robby/four-opencode-supertools"]
}
```

**TUI sidebar:** also register in `~/.config/opencode/tui.json` if using GitLab MR tools.

Restart opencode for the plugin to load.

## Development

```bash
mise run setup     # Install dependencies
mise run build     # Build the plugin
mise run test      # Run tests
mise run typecheck # Type check
mise run lint      # Lint code
mise run format    # Format code
```

## Requirements

- Bun >= 1.0
- opencode with plugin support

## Architecture

See [AGENTS.md](AGENTS.md) for code architecture and [ROADMAP.md](ROADMAP.md) for the evolution plan.

## License

Apache-2.0 © Four Bytes / Four Flames GmbH & Co. KG


---

> If these tools save you tokens, consider leaving a ⭐ on [GitHub](https://github.com/four-bytes/four-opencode-supertools).