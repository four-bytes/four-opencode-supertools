# AGENTS.md — four-opencode-supertools

## Pointer
- Meta-repo: `~/four-opencode-plugins/`
- Repo: `four-bytes/four-opencode-supertools`
- Package: `@four-bytes/four-opencode-supertools` v0.4.5
- Build: `bun run build` → `dist/four-opencode-supertools.js`
- Test: `bun test`

## Tool Stack (13 tools)
### File Editing (4 tools)
- `batch_edit` — grep→replace across N files. Saves ~80% tokens vs. grep→read→edit×N
- `lint_file` — run linter, return errors+warnings. Auto-detects eslint/phpstan/ruff. Saves ~60% tokens
- `run_tests` — run test file, return failures only. Auto-detects bun/phpunit/jest. Saves ~50% tokens
- `append_file` — append/prepend text to file. Saves ~95% tokens vs. patch for simple additions

### Smart Editing (3 tools)
- `smart_edit` — fuzzy string replace with whitespace tolerance. Exact match first, then normalized retry
- `smart_patch` — context-anchored patch ignoring line numbers. Sliding-window context search with fuzz tolerance
- `batch_patch` — multi-file patch in one call. Optional atomic mode: snapshot→apply→rollback on failure

### Meta-Tools (3 tools)
- `file_tree` — structured directory listing with sizes. Skips .git/node_modules/vendor by default
- `research` — parallel brain_search + websearch in one call. Saves 2 round trips
- `solution_confidence` — weighted verification scoring (tests 0.4 + KB match 0.3 + coverage 0.3)

### LSP / Structure (3 tools)
- `lsp_references` — find all references to a symbol via LSP. Saves ~90% tokens vs grep + tracing
- `lsp_hover` — type info + docs for a symbol via LSP. Saves ~95% tokens vs reading source
- `file_outline` — structure-only outline (symbols + line numbers) via LSP, regex fallback. Never returns file contents. Saves ~95% tokens

## Architecture
- Entry: `src/four-opencode-supertools.ts` — registers all 13 tools
- Tools: `src/tools/` — one file per tool, all use `tool()` from `@opencode-ai/plugin`
- Lib: `src/lib/` — diff-parse.ts, debug-logger.ts
- Tests: `tests/` — 129 tests, bun-native

## Dependencies
- `@opencode-ai/plugin` 1.15.13 (exact pin)
- Bun runtime, ESM modules

- **Console logging:** Plugins MUST use `_client?.app?.log()` for all logging in plugin mode — `console.log` / `console.warn` / `console.error` is ONLY permitted for the initial startup `"init"` message. Console output in plugin mode breaks the terminal UI.
