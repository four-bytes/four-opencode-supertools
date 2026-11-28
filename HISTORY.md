# History — four-opencode-supertools

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
