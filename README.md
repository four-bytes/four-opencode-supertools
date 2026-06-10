# four-opencode-supertools

Token-efficient supertools for opencode agents. Each tool saves significant tokens by replacing multi-step workflows with single, optimized calls.

## Tools

### Code Editing & Quality

| Tool              | Token Savings | Description                                           |
| ----------------- | ------------- | ----------------------------------------------------- |
| **`apply_patch`** | ~90%          | Apply unified diff patch instead of full-file `write` |
| **`batch_edit`**  | ~80%          | Search and replace across multiple files in one call  |
| **`lint_file`**   | ~60%          | Run linter on specific file, return errors only       |
| **`run_tests`**   | ~50%          | Run specific test file, return failures only          |

### Git Tools

| Tool                    | Token Savings | Description                                             |
| ----------------------- | ------------- | ------------------------------------------------------- |
| **`curse_score`**       | ~90%          | Rank files by risk via curse score algorithm            |
| **`bus_factor`**        | ~85%          | Ownership concentration per directory                   |
| **`implicit_coupling`** | ~100%         | Hidden co-change dependencies                           |
| **`ownership`**         | ~80%          | Author breakdown per file/directory                     |
| **`blast_radius`**      | ~95%          | Impact analysis — what might break?                     |
| **`git_diff`**          | ~90%          | Structured git diff output (staged, file, between refs) |
| **`trend`**             | ~90%          | Curse score trends — files getting more dangerous       |
| **`pr_risk`**           | ~90%          | Risk assessment of uncommitted changes                  |
| **`git_log_structured`**| ~50%          | Structured git log with filters                         |

### `apply_patch`

Apply a unified diff patch to a file. Uses standard `@@ -old +new @@` format.

**Parameters:**

- `file_path` (string) — Absolute path to the file
- `patch` (string) — Unified diff patch

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

### `git_diff`

Get git diff as structured output with file-level summary and line counts. Complements `apply_patch` (produce diff → apply diff).

**Parameters:**

- `staged` (boolean, optional) — Show staged changes (`git diff --staged`)
- `file` (string, optional) — Specific file path to diff
- `from` (string, optional) — From commit/branch/ref
- `to` (string, optional) — To commit/branch/ref (defaults to HEAD if from is set)

## Install

Add to your `opencode.json`:

```json
{
  "plugin": ["file:///home/robby/four-opencode-supertools"]
}
```

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
