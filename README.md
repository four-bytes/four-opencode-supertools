# four-opencode-supertools

[![npm](https://img.shields.io/npm/v/@four-bytes/four-opencode-supertools)](https://www.npmjs.com/package/@four-bytes/four-opencode-supertools)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)

Token-efficient supertools for opencode agents. Each tool saves significant tokens by replacing multi-step workflows with single, optimized calls.

## Tools

The plugin registers **12 tools**. This table mirrors the authoritative tool
stack in [AGENTS.md](AGENTS.md).

### File Editing (4)

| Tool              | Token Savings | Description                                          |
| ----------------- | ------------- | ---------------------------------------------------- |
| **`batch_edit`**  | ~80%          | Search and replace across multiple files in one call |
| **`append_file`** | ~95%          | Append or prepend text to a file                     |
| **`lint_file`**   | ~60%          | Run linter on a specific file, return errors only    |
| **`run_tests`**   | ~50%          | Run a specific test file, return failures only       |

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

### LSP / Structure (3)

| Tool                 | Token Savings | Description                                                       |
| -------------------- | ------------- | ----------------------------------------------------------------- |
| **`file_outline`**   | ~95%          | Structure-only outline (symbols + line numbers), never file bodies |
| **`lsp_hover`**      | ~95%          | Type info and documentation for a symbol at a position            |
| **`lsp_references`** | ~90%          | Find all references to a symbol at a position                      |

> Git, GitHub and GitLab tools live in the separate `four-opencode-git` plugin.

### `batch_edit`

Search and replace across multiple files matching a glob pattern.

**Parameters:**

- `search` (string) — Regex pattern to find
- `replace` (string) — Replacement text ($1, $2 for capture groups)
- `glob` (string) — File pattern (e.g., `src/**/*.ts`)
- `path` (string, optional) — Base directory
- `dry_run` (boolean, optional) — Preview without writing

### `lint_file`

Run appropriate linter on a file and return only errors/warnings.

**Parameters:**

- `file_path` (string) — File to lint
- `linter` (string, optional) — `eslint`, `phpstan`, `pint`, `ruff`, or `auto`

### `run_tests`

Run tests for a specific file and return only failures.

**Parameters:**

- `test_file` (string) — Test file to run
- `filter` (string, optional) — Test name pattern
- `framework` (string, optional) — `bun`, `phpunit`, `jest`, `vitest`, or `auto`

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