# History — four-opencode-supertools

All notable changes to this project. Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.4.7] - 2026-11-27

### Changed
- `lint_file` Rust: run `cargo clippy --all-targets` so tests, benches and examples are linted (#109).
- `lint_file` Rust: normalise clippy diagnostic paths against `cargo metadata` `workspace_root` before the exact-path filter (#109).
- AGENTS.md package version aligned with package.json (#109).
