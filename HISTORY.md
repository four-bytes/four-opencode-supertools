# History — four-opencode-supertools

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.11.0] - 2026-11-28

### Added
- New `twig_blocks` in the `symfony` module: shows the full override chain for a block or template — `extends`, `block`, `parent()`, `use`, `embed` and `include` — with compact `path:line` references and never file contents (#91).
- Tolerant pure-TS Twig scanner (`src/lib/twig/scanner.ts`): block open/close with `parentCall`, extends/use/embed/include, unknown-tag reporting, comment and verbatim skipping, CRLF-safe line numbers. Malformed input never throws (#91).
- Loader/template resolver (`src/lib/twig/resolver.ts`): runtime `debug:twig --format=json` loader paths and namespaces, static `config/packages/twig.(yaml|yml)` fallback marked incomplete, `@Bundle` resolution with `templates/bundles/<Bundle>/` overrides before namespace and bounded vendor search, plus cycle-safe extends chains (#91).
- Block chain builder (`src/lib/twig/blocks.ts`): base → derived ordering by extends depth, bundle overrides after their base, bounded template walk and aggregated unknown tags (#91).
- Tests: a Symfony-like Twig fixture (runtime `debug:twig` JSON, static-only fixture, bundle base + override, unknown tag) and 21 new bun-native tests (#91).
- `twig_blocks` auto-detects custom inheritance tags from project Twig extensions (`ExtendsTokenParser` → `extends`, `IncludeTokenParser` → `include`, `EmbedTokenParser` → `embed`, `UseTokenParser` → `use`, `BlockTokenParser` → `block`) and merges them with `.supertools.json` `twig.tags` (config wins), over a bounded `src/` scan (#92).
- New `twig.discovery.vendor` (default `false`) and `twig.discovery.maxFiles` (default `3000`) config keys; unmapped tags carry a mapping hint and metadata reports `customTags`, `configTags` and `discoveryIncomplete`. Discovery is graceful: a missing `src/`, unreadable files or a capped scan never fail the tool (#92).
- Tests: custom-tag discovery fixtures (extension + token parsers, unmapped parent), scanner `tagMap` cases and config-override/tool integration, plus discovery config validation (#92).
- Shopware resolver library (`src/lib/shopware/`): active plugin load order from runtime `plugin:list` (JSON, legacy `--json`, then text table) and static `custom/plugins`, `custom/static-plugins` and `custom/apps` fallback; effective theme inheritance/view chain from `dbal:run-sql` theme rows merged with `theme.json`, parent chains, `@Plugins` expansion over active plugins only, de-duplicated view roots and honest `unresolved`/`incomplete` reporting. Library only — no tool or version change (#93).

### Changed
- Tool count 20 → 21; the `symfony` module now registers `twig_blocks` (#91).

### Fixed
- `bun run build` empties `dist/` before bundling (new `clean` script), so stale content-hashed chunks no longer pile up and ship in the published package (#126).

## [0.10.0] - 2026-11-28

### Added
- New `change_route_path` in the `php` module: rewrites the path argument of `#[Route()]` attributes project-wide, AST-based via tree-sitter-php. Only the first positional argument or a named `path:` argument is touched, single/double quote style is preserved, and an exact value match is required — no other strings, comments, docblocks or arguments change (#121).
- The project scan is explicit and bounded by `maxFiles` (default 500, warns when truncated); an optional explicit `files` list replaces the walk. `preview` reports changes without writing, and each modified file is re-parsed before it is written (#121).

### Changed
- Tool count 19 → 20; the `php` module now registers `change_route_path` (#121).

## [0.9.0] - 2026-11-28

### Added
- New `lsp_code_action` in the `lsp` module: `mode: list` prints one compact line per `textDocument/codeAction` result; `mode: apply` selects by `index`, exact `title` or exact `kind` (#86).
- Deferred actions are completed through `codeAction/resolve`; command-only actions run via `workspace/executeCommand`, and edits the server pushes through `workspace/applyEdit` are collected and applied (#86).
- WorkspaceEdits are applied through the atomic applier from #85; `dryRun` returns files, edit count and a bounded preview without writing; unknown/ambiguous selectors list the available actions and change nothing (#86).
- LSP client advertises code-action literal/resolve/disabled capabilities and `workspace.applyEdit`, and answers server-initiated `workspace/applyEdit` requests (#86).

### Changed
- Tool count 18 → 19; `lsp` module now registers `lsp_code_action` (#86).

## [0.8.0] - 2026-11-28

### Added
- `rename_symbol` dispatches by file extension: `.php` keeps the existing tree-sitter implementation unchanged, while Go, Rust, TypeScript/JavaScript and any other language with a registered LSP server use `textDocument/prepareRename` + `textDocument/rename` and apply the returned `WorkspaceEdit` atomically (#85).
- New `workspace-edit` applier: bottom-up edits, overlap rejection, dry-run preview and all-or-nothing writes with rollback; supports both `changes` and `documentChanges` (#85).
- `rename_symbol` is now registered by the `go`, `rust` and `typescript` modules (gated per target language) in addition to `php` (#85).
- New optional `dry_run` argument for the LSP path; `preview` acts as a dry run there too (#85).

### Changed
- `ModuleDefinition.tools` now receives the resolved active module ids, so a tool can gate its behaviour by language module (#85).
- Tests: 373 (bun-native), including workspace-edit atomicity, cross-file LSP dispatch with injected fake servers, and live gopls/rust-analyzer/tsserver checks that skip when the server is absent (#85).

## [0.7.0] - 2026-11-28

### Added
- New `typescript` module (requires `lsp`), auto-detected via `tsconfig.json`, `package.json` or `deno.json(c)`; `lint_file` and `run_tests` gain TypeScript/Deno support (#107).
- `lint_file`: `typecheck: true` runs `tsc --noEmit -p <nearest tsconfig>` and merges the file's diagnostics with the linter; the `tsc` linter and `deno` lint + check (JSON, ANSI-stripped) are also selectable (#107).
- `run_tests`: `deno test` for Deno projects (failures only, `--filter` support) (#107).

### Changed
- `lint_file` / `run_tests` select Deno for `.ts`/`.js` files in a Deno project before ESLint/Bun; Bun projects keep `bun test` unchanged (#107).

## [0.6.2] - 2026-11-27

### Changed
- The `tsc` and ESLint gates now cover `tests/` as well as `src/`: `tsconfig.json` includes both trees (excluding `tests/fixtures`), and `bun run lint` runs `eslint src/ tests/` (#114).
- Tests were narrowed to the real tool contracts (`ToolResult` object branch, required schema arguments) without changing assertions or expected values (#114).

## [0.6.1] - 2026-11-27

### Fixed
- Wire LSP registry shutdown to the plugin `dispose` hook. `peekLspRegistry()` returns the existing singleton without creating one, so dispose is a no-op when no registry was ever created (#113).

## [0.6.0] - 2026-11-27

### Added
- `symfony_service`: service lookup by id/class/partial/tag with class, arguments, tags, alias and decorator chain; runtime `debug:container --format=json` with static `config/services.*` fallback (`incomplete`) (#90).
- `symfony_events`: event listeners sorted by priority; runtime `debug:event-dispatcher --format=json` with static `kernel.event_listener` tags + `getSubscribedEvents()` fallback (`incomplete`) (#90).
- The `symfony` module (requires `php`) now registers both tools (#90).

## [0.5.0] - 2026-11-27

### Added
- LSP: marker-based server selection including `deno lsp` (#106).
- LSP: per-server project-root resolution for TypeScript/Deno, Go (`go.work` before `go.mod`), PHP and Cargo workspaces (outermost `[workspace]`, `package.workspace` honoured) (#106).
- LSP: `.supertools.json` `lsp.servers` overrides and `lsp.idleTimeoutMs` via the framework config loader (#106).

### Changed
- LSP: client pool keyed by (server, canonical root); idle clients shut down after a configurable timeout via shutdown → exit → kill (#106).
- LSP: tools pass their project directory to the config loader (#106).

## [0.4.7] - 2026-11-27

### Changed
- `lint_file` Rust: run `cargo clippy --all-targets` so tests, benches and examples are linted (#109).
- `lint_file` Rust: normalise clippy diagnostic paths against `cargo metadata` `workspace_root` before the exact-path filter (#109).
- AGENTS.md package version aligned with package.json (#109).
