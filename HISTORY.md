# History — four-opencode-supertools

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
