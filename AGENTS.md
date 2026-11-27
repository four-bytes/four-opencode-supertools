# AGENTS.md — four-opencode-supertools

## Pointer
- Meta-repo: `~/four-opencode-plugins/`
- Repo: `four-bytes/four-opencode-supertools`
- Package: `@four-bytes/four-opencode-supertools` v0.6.0
- Build: `bun run build` → `dist/four-opencode-supertools.js`
- Test: `bun test`

## Tool Stack (18 tools, grouped into modules)
Module bundles: `core` (editing/meta), `search`, `lsp`, `php` (AST), plus `go`, `rust`, `symfony`; `doctrine` and `shopware` are reserved for later issues. See `src/lib/modules/` and `src/modules/`.

### File Editing (4 tools)
- `batch_edit` — grep→replace across N files. Saves ~80% tokens vs. grep→read→edit×N
- `lint_file` — run linter, return errors+warnings. Auto-detects eslint/phpstan/ruff/golangci-lint (Go: package of the file) / cargo clippy (Rust: crate of the file). Saves ~60% tokens
- `run_tests` — run test file, return failures only. Auto-detects bun/phpunit/jest/vitest/go test/cargo test. Saves ~50% tokens
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

### LSP / Structure (3 tools)
- `lsp_references` — find all references to a symbol via LSP. Saves ~90% tokens vs grep + tracing
- `lsp_hover` — type info + docs for a symbol via LSP. Saves ~95% tokens vs reading source
- `file_outline` — structure-only outline (symbols + line numbers) via LSP, regex fallback. Never returns file contents. Saves ~95% tokens

The LSP registry pools one client per (server, canonical project root), resolves roots from markers (tsconfig/package.json, deno.json(c), go.work/go.mod, composer.json, outermost Cargo `[workspace]`), and shuts idle clients down after 10 min (`lsp.idleTimeoutMs`, negative disables). Deno projects select `deno lsp`.

### Symfony (2 tools)
- `symfony_service` — service id/class/partial/tag lookup: class, arguments, tags, alias and decorator chain. Runtime `debug:container --format=json`; static `config/services.*` fallback marked `source: static, incomplete: true`
- `symfony_events` — event listeners sorted by priority (`class::method prio`). Runtime `debug:event-dispatcher --format=json`; static tag + `getSubscribedEvents()` fallback marked incomplete

### AST / PHP Refactoring (3 tools)
- `extract_method` — extract complete statements into a new method. Rejects partial statements, return/yield/goto, escaping break/continue, static `$this`, and values that escape
- `rename_symbol` — rename one declaration + provably same-scope references in a single file (structural tree-sitter matching; NOT semantic cross-file resolution). `line` disambiguates duplicates; variables require `line`
- `move_class` — move a class-like declaration; copies the source `declare()` block verbatim, copies referenced `use` imports, resolves the namespace from `composer.json` PSR-4 or an explicit `namespace`; never overwrites a non-empty target

## Architecture
- Entry: `src/four-opencode-supertools.ts` — delegates to the module registry (`src/lib/modules/`) and registers the active tool bundles
- Modules: `src/modules/<id>.ts` — one definition per module, tools loaded lazily via dynamic import
- Tools: `src/tools/` — one file per tool, all use `tool()` from `@opencode-ai/plugin`
- Lib: `src/lib/` — diff-parse.ts, debug-logger.ts, php-parser.ts (shared tree-sitter setup)
- Framework: `src/lib/framework/` — Symfony/Shopware detection, `bin/console` runner, and `.supertools.json` config
- Tests: `tests/` — 301 tests, bun-native

## Dependencies
- `@opencode-ai/plugin` 1.15.13 (exact pin)
- `web-tree-sitter` + `tree-sitter-php` (AST tools; wasm copied into `dist/` by the build)
- Bun runtime, ESM modules

- **Console logging:** Plugins MUST use `_client?.app?.log()` for all logging in plugin mode — `console.log` / `console.warn` / `console.error` is ONLY permitted for the initial startup `"init"` message. Console output in plugin mode breaks the terminal UI.
