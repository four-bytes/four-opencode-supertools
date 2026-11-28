# AGENTS.md — four-opencode-supertools

## Pointer
- Meta-repo: `~/four-opencode-plugins/`
- Repo: `four-bytes/four-opencode-supertools`
- Package: `@four-bytes/four-opencode-supertools` v0.15.0
- Build: `bun run build` → `dist/four-opencode-supertools.js`
- Typecheck: `bun run typecheck` (`tsc --noEmit`, checks `src/` **and** `tests/`)
- Lint: `bun run lint` (`eslint src/ tests/`)
- Test: `bun test`

## Tool Stack (35 tools, grouped into modules)
Module bundles: `core` (editing/meta), `search`, `lsp`, `php` (AST), plus `typescript` (requires `lsp`; tsc/Deno lint/check/test), `go`, `rust`, `symfony`, `shopware`, `termlab` (terminal lab; tmux oracle, needs tmux for `term_run`/`trace_replay`/the `tmux` width model), `imagelab` (image lab; pure-TS PNG diff/sampling/compose, Sixel decode, WCAG contrast; opt-in unless golden PNG snapshots exist; no dependency on termlab/core); `doctrine` is reserved for a later issue. See `src/lib/modules/` and `src/modules/`.

### File Editing (4 tools)
- `batch_edit` — grep→replace across N files. Saves ~80% tokens vs. grep→read→edit×N
- `lint_file` — run linter, return errors+warnings. Auto-detects eslint/tsc (`typecheck: true`) / deno lint+check / phpstan/ruff/golangci-lint (Go: package of the file) / cargo clippy (Rust: crate of the file). Saves ~60% tokens
- `run_tests` — run test file, return failures only. Auto-detects bun/phpunit/jest/vitest/go test/cargo test/deno test. Saves ~50% tokens
- `append_file` — append/prepend text to file. Saves ~95% tokens vs. patch for simple additions

### Smart Editing (3 tools)
- `smart_edit` — fuzzy string replace with whitespace tolerance. Exact match first, then normalized retry
- `smart_patch` — context-anchored patch ignoring line numbers. Sliding-window context search with fuzz tolerance
- `batch_patch` — multi-file patch in one call. Optional atomic mode: snapshot→apply→rollback on failure

### Meta-Tools (2 tools)
- `file_tree` — structured directory listing with sizes. Skips .git/node_modules/vendor by default
- `solution_confidence` — weighted verification scoring (tests 0.5 + coverage 0.5)

### Search (1 tool)
- `sonar_search` — Perplexity Sonar web search (sonar fast default / sonar-pro opt-in). Returns answer + citations.

### LSP / Structure (4 tools)
- `lsp_references` — find all references to a symbol via LSP. Saves ~90% tokens vs grep + tracing
- `lsp_hover` — type info + docs for a symbol via LSP. Saves ~95% tokens vs reading source
- `file_outline` — structure-only outline (symbols + line numbers) via LSP, regex fallback. Never returns file contents. Saves ~95% tokens
- `lsp_code_action` — list/apply server-side code actions for a range (extract function, stub interface methods, fill match arms, organize imports). Language-agnostic; `mode: apply` selects by `index`, exact `title` or exact `kind`, `dryRun` previews

The LSP registry pools one client per (server, canonical project root), resolves roots from markers (tsconfig/package.json, deno.json(c), go.work/go.mod, composer.json, outermost Cargo `[workspace]`), and shuts idle clients down after 10 min (`lsp.idleTimeoutMs`, negative disables). Deno projects select `deno lsp`.

### Symfony (3 tools)
- `symfony_service` — service id/class/partial/tag lookup: class, arguments, tags, alias and decorator chain. Runtime `debug:container --format=json`; static `config/services.*` fallback marked `source: static, incomplete: true`
- `symfony_events` — event listeners sorted by priority (`class::method prio`). Runtime `debug:event-dispatcher --format=json`; static tag + `getSubscribedEvents()` fallback marked incomplete
- `twig_blocks` — Twig override chain for a block or template: `extends`, `block`, `parent()`, `use`, `embed`, `include` with `path:line`. Auto-detects custom inheritance tags from project Twig extensions and honours `.supertools.json` `twig.tags`; runtime `debug:twig --format=json`; static `config/packages/twig.*` fallback marked incomplete; tolerant scanner reports unknown tags. In Shopware projects (shopware module active) a Storefront adapter maps `sw_extends`/`sw_include` (plus `sw_embed`/`sw_use`) onto the built-in semantics, treats every other `sw_*` tag as known, and resolves the storefront → plugin → theme view chain from the Shopware resolver; optional `theme` (name/technical name) and `salesChannel` (hex id) args filter the chain

### Shopware (2 tools)
- `sw6_plugin` — Shopware 6 plugins. `mode: list` reports state and load order; `mode: overview` lists what one plugin registers (services, scheduled tasks, subscribers, entities, migrations, admin modules, Twig overrides) with `path:line` and a `sw6_theme` pointer for theme plugins; `mode: lifecycle` plans or runs the console sequence (`plugin:install|activate|deactivate|update|uninstall|refresh` + `cache:clear`, plus `theme:compile` for theme state changes). Lifecycle is a dry run unless `confirm: true`; uninstall keeps user data unless `keepUserData: false`.
- `sw6_theme` — Shopware 6 themes. `mode: list` reports the theme hierarchy with parent chains and sales-channel assignments; `mode: resolve` returns the effective view chain plus declared style/script assets (most-specific first) for one theme or a sales channel; `mode: compile` runs `theme:compile` (idempotent, no confirm gate) and returns SCSS errors as `path:line[:col] message`, never raw output. `salesChannel` maps to `--only=<id>` (Shopware 6.5+) for compile and to the bound theme for resolve; `timeoutMs` is clamped to 1000…900000

### Terminal Lab (6 tools)
- `term_run` — drive a headless tmux session: send literal text, named keys or SGR mouse events per step and capture changed rows with attribute runs; optional per-step DECRQCRA-style checksum; each run owns a private tmux server and always kills it. Returns `available:false` when tmux is missing
- `trace_decode` — turbo-tui `TURBO_TUI_TRACE` v1 → one compact op line per terminal operation (MOVE, SGR, OSC8, TEXT, CLEAR, …) per frame; frame-range and region filters, bounded per-frame op limit
- `trace_replay` — replay recorded frames through an independent tmux emulator and compare the rendered screen against the recorded back buffer and modifier masks (colour never compared); `ok:true matched:false` reports divergences as data. Needs tmux
- `cell_history` — ordered writes per screen cell over a trace (character, modifier names/mask, OSC 8 link) by simulating the recorded byte stream; pure TypeScript, no tmux
- `width_check` — grapheme display width under unicode-width, wcwidth and an independent tmux emulator model (em dash, emoji, VS16, CJK); flags where the models disagree
- `term_checksum` — DECRQCRA-style `utf16-sum-mod-65536`: compute over a screen dump or a trace frame back buffer, emit the DECRQCRA query (`CSI Pid;Pp;Pt;Pl;Pb;Pr*y`), parse the DECCKSR response (`DCS Pid!~hhhh ST` / `CSI Pid;value*y`); attributes are never included

The oracle is tmux only — an independent VT implementation, not the user's terminal (Windows Terminal/Kitty/WezTerm rendering bugs cannot be reproduced). Trace format v1, walkthroughs and limitations: `docs/termlab.md`.

### Image Lab (6 tools)
- `img_diff` — pixel-diff two PNGs: changed pixels (max abs per-channel delta incl. alpha vs `threshold`, default 0), ratio, max/mean delta, 4-connected changed regions (largest first, `maxRegions` default 20), highlighted diff PNG (`highlight` #ff0044, unchanged = B dimmed `dim` 0.35) and optional side-by-side A│B│DIFF composite (`labels` max 3)
- `img_sample` — pixel colours (hex/rgba per point), region stats (`uniqueColors`/`mean`/`dominant`) and dominant palette (5 bits/channel buckets, `colors` 1..32 default 8) from a PNG
- `img_crop_scale` — crop a region (default full image) and integer nearest-neighbour scale (1..32 default 1) into `<name>.crop.png`
- `img_compose` — compose 1..8 PNGs (optional labels, built-in 5x7 uppercase font, `?` fallback) horizontal/vertical/grid (`columns` default ceil(sqrt(count))), `gap` 8, `background` #101010, `labelHeight` 12/`labelScale` 1, integer `scale` 1..16, output `imagelab-compose.png`
- `sixel_decode` — decode a bare or DCS-wrapped Sixel stream (`path` XOR `data`) to PNG: RGB/HLS colour definitions, `!` repeats, `$`/`-` band controls, `"` raster attributes → `declared`; reports size, bands, palette and `coloursUsed`; undefined registers are black
- `contrast_check` — WCAG 2.x contrast ratios for explicit `pairs` and/or fg/bg keys from a skin/theme JSON (`background` fallback #000000); flags `aa` ≥ 4.5, `aaa` ≥ 7, large text 3 / 4.5

Pure TypeScript (`node:zlib` PNG codec, no new dependency), 16M-pixel cap, images always written to files — context gets numbers/paths/palettes only. Independent of `termlab` and `core`; opt-in via `"modules": ["imagelab"]` unless golden PNG snapshots are auto-detected. Details: `docs/imagelab.md`.

### AST / Refactoring (4 tools)
- `extract_method` — extract complete statements into a new method. Rejects partial statements, return/yield/goto, escaping break/continue, static `$this`, and values that escape
- `rename_symbol` — rename a symbol. PHP: tree-sitter, one file, provably same-scope references (structural, NOT semantic cross-file resolution); variables require `line`. Go/Rust/TS/JS: LSP `prepareRename` + `rename`, applied atomically (needs `lsp` + the language module); `line` disambiguates, `preview`/`dry_run` preview without writing
- `move_class` — move a class-like declaration; copies the source `declare()` block verbatim, copies referenced `use` imports, resolves the namespace from `composer.json` PSR-4 or an explicit `namespace`; never overwrites a non-empty target
- `change_route_path` — rewrite `#[Route()]` path arguments (positional or `path:`) project-wide; AST-based, exact match only, preview writes nothing, capped by `maxFiles`

## Architecture
- Entry: `src/four-opencode-supertools.ts` — delegates to the module registry (`src/lib/modules/`) and registers the active tool bundles
- Modules: `src/modules/<id>.ts` — one definition per module, tools loaded lazily via dynamic import
- Tools: `src/tools/` — one file per tool, all use `tool()` from `@opencode-ai/plugin`
- Lib: `src/lib/` — diff-parse.ts, debug-logger.ts, php-parser.ts (shared tree-sitter setup), `twig/` (tolerant Twig scanner, loader/template resolver, block chain), `shopware/` (plugin load order, theme inheritance/view chain, plugin report/lifecycle), `termlab/` (trace parser, tmux oracle, SGR screen model, width models, checksum), `imagelab/` (PNG codec, raster/colour helpers, diff/regions, compose + 5x7 label font, Sixel decoder, palette sampling, WCAG contrast, golden-snapshot detection)
- Framework: `src/lib/framework/` — Symfony/Shopware detection, `bin/console` runner, and `.supertools.json` config
- Tests: `tests/` — 725 tests, bun-native

## Dependencies
- `@opencode-ai/plugin` 1.15.13 (exact pin)
- `web-tree-sitter` + `tree-sitter-php` (AST tools; wasm copied into `dist/` by the build)
- Bun runtime, ESM modules

- **Console logging:** Plugins MUST use `_client?.app?.log()` for all logging in plugin mode — `console.log` / `console.warn` / `console.error` is ONLY permitted for the initial startup `"init"` message. Console output in plugin mode breaks the terminal UI.
