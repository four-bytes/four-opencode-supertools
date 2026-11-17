# four-opencode-supertools

[![npm](https://img.shields.io/npm/v/@four-bytes/four-opencode-supertools)](https://www.npmjs.com/package/@four-bytes/four-opencode-supertools)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)

Token-efficient supertools for opencode agents. Each tool saves significant tokens by replacing multi-step workflows with single, optimized calls.

## Tools

The plugin registers **16 tools**. This table mirrors the authoritative tool
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

### Search (1)

| Tool               | Description                                        |
| ------------------ | -------------------------------------------------- |
| **`sonar_search`** | Perplexity Sonar web search — answer + citations   |

### LSP / Structure (3)

| Tool                 | Token Savings | Description                                                       |
| -------------------- | ------------- | ----------------------------------------------------------------- |
| **`file_outline`**   | ~95%          | Structure-only outline (symbols + line numbers), never file bodies |
| **`lsp_hover`**      | ~95%          | Type info and documentation for a symbol at a position            |
| **`lsp_references`** | ~90%          | Find all references to a symbol at a position                      |

### AST / PHP Refactoring (3)

| Tool                | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **`extract_method`** | Extract complete statements into a new method; rejects unsupported data/control-flow cases    |
| **`rename_symbol`**  | Rename a declaration + provably same-scope references in one file (structural, not semantic) |
| **`move_class`**     | Move a class-like declaration, preserving declare blocks and referenced `use` imports         |

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

Run appropriate linter on a file and return only errors/warnings. For `.go` files golangci-lint (v2) lints the file's package from the nearest `go.mod`; `govet` and `staticcheck` are part of its standard set.

**Parameters:**

- `file_path` (string) — File to lint
- `linter` (string, optional) — `eslint`, `phpstan`, `pint`, `ruff`, `golangci`, or `auto`

### `run_tests`

Run tests for a specific file and return only failures. In a Go module (`go.mod` in the project directory) it runs `go test` on the package of the given `_test.go` file.

**Parameters:**

- `test_file` (string) — Test file to run
- `filter` (string, optional) — Test name pattern
- `framework` (string, optional) — `bun`, `phpunit`, `jest`, `vitest`, `go`, or `auto`

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

### `extract_method`

Extract complete statements from a PHP method into a new method using tree-sitter.

The selection must align with complete statements inside one block. The extracted
method receives every pre-existing variable it reads as an untyped by-reference
parameter, so in-place mutations of caller variables keep working; the call site
passes them back. Static methods use `self::` and a `static` signature.

**Rejected loudly (no silent wrong edit):** partial statements, selections spanning
block boundaries, `return`/`yield`/`goto`, `break`/`continue` that jump out of the
selection, `$this` inside a static method, values assigned in the selection and read
afterwards, and method-name collisions.

**Parameters:**

- `filePath` (string) — Absolute PHP file path
- `startLine` / `endLine` (number) — 1-based inclusive statement range
- `newMethodName` (string) — Valid PHP method name
- `visibility` (`private` | `protected` | `public`, optional) — Default `private`

### `rename_symbol`

Rename a PHP declaration and provably same-scope references in **one file**. The
matching is structural (tree-sitter), with optional line targeting. It is **not**
semantic cross-file reference resolution: imports and references in other files are
not updated and a warning says so.

- Same-class `$this->`, `self::` and `static::` usages are renamed by default.
- Same-name members on other objects/classes are counted and reported as warnings.
- Duplicate declarations of the same name are ambiguous: pass `line` to select one.
- Variable renames require `line` — variables are scope-bound and file-wide matching
  would rename unrelated functions.

**Parameters:**

- `filePath` (string) — Absolute PHP file path
- `oldName` / `newName` (string) — Existing symbol name (leading `$` allowed for
  variables) and valid new PHP identifier
- `symbolKind` (string, optional) — `class`, `method`, `function`, `variable`,
  `interface`, `trait`, `property` or `constant`
- `line` (number, optional) — 1-based line inside the declaration to disambiguate
- `column` (number, optional) — 1-based column hint (requires `line`)
- `preview` (boolean, optional) — Return changes without modified content
- `renameUsages` (boolean, optional) — Default `true`; `false` leaves same-scope
  usages unchanged and reports them as warnings

### `move_class`

Move a class, interface, trait or enum to another file using tree-sitter.

- The source `declare(...)` block is copied verbatim; `strict_types` is never
  injected or upgraded.
- Referenced `use` statements are copied to the target file (unused imports are not).
- The target namespace comes from an explicit `namespace` argument or the nearest
  `composer.json` PSR-4 mapping (`autoload` / `autoload-dev`). If neither yields a
  unique namespace, the operation fails instead of guessing.
- Unresolved short class names that are neither imported nor built in are reported
  as warnings (after a namespace move they would resolve against the new namespace).
- A non-empty target file is never overwritten.

**Parameters:**

- `sourcePath` (string) — Absolute path to the current PHP file
- `className` (string) — Class-like name to move
- `targetPath` (string) — Target PHP file path (absolute or relative to cwd)
- `namespace` (string, optional) — Explicit target namespace

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