# four-opencode-supertools

[![npm](https://img.shields.io/npm/v/@four-bytes/four-opencode-supertools)](https://www.npmjs.com/package/@four-bytes/four-opencode-supertools)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)
[![bun](https://img.shields.io/badge/runtime-bun-orange)](https://bun.sh)

Token-efficient supertools for opencode agents. Each tool saves significant tokens by replacing multi-step workflows with single, optimized calls.

## Tools

The plugin registers up to **21 tools**, grouped into selectable modules (see
[Modules](#modules)). The default `"modules": "auto"` registers every tool that
applies to the project — a Symfony PHP project gets all 21. This table mirrors the
authoritative tool stack in [AGENTS.md](AGENTS.md).

### File Editing (4)

| Tool              | Token Savings | Description                                          |
| ----------------- | ------------- | ---------------------------------------------------- |
| **`batch_edit`**  | ~80%          | Search and replace across multiple files in one call |
| **`append_file`** | ~95%          | Append or prepend text to a file                     |
| **`lint_file`**   | ~60%          | Run linter (ESLint/tsc/Deno/PHP/Go/Rust) on a file, errors only |
| **`run_tests`**   | ~50%          | Run a test file (Bun/Vitest/Jest/PHPUnit/Go/Cargo/Deno), failures only |

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

### LSP / Structure (4)

| Tool                  | Token Savings | Description                                                                  |
| --------------------- | ------------- | ---------------------------------------------------------------------------- |
| **`file_outline`**    | ~95%          | Structure-only outline (symbols + line numbers), never file bodies            |
| **`lsp_hover`**       | ~95%          | Type info and documentation for a symbol at a position                       |
| **`lsp_references`**  | ~90%          | Find all references to a symbol at a position                                 |
| **`lsp_code_action`** | ~85%          | List/apply code actions for a range (extract, stub methods, organize imports) |

The LSP registry resolves each server's project root from markers (nearest `tsconfig.json`/`package.json`, `deno.json(c)`, `go.work` before `go.mod`, `composer.json`, and the outermost Cargo `[workspace]`), pools one client per server and canonical root, and shuts idle clients down after 10 minutes. Deno projects use `deno lsp`; `.supertools.json` accepts `lsp.servers` overrides and `lsp.idleTimeoutMs` (negative disables idle shutdown).

`lsp_code_action` is language-agnostic and prints one line per action. Typical kinds: Go — `refactor.extract.function`/`.variable` and `quickfix` stub methods; Rust — `refactor.extract.function` and fill match arms; TypeScript/JavaScript — `refactor.extract.function`/`.constant` and `source.organizeImports`. Apply with `index`, exact `title` or exact `kind`; `dryRun` returns the diff summary without writing.

### Symfony (3)

| Tool                | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| **`symfony_service`** | Service by id/class/partial/tag: class, arguments, tags, decorator chain |
| **`symfony_events`**  | Event listeners sorted by priority (`class::method prio`)                |
| **`twig_blocks`**     | Twig override chain for a block/template with `path:line`                |

All three call `bin/console` (`debug:container` / `debug:event-dispatcher` /
`debug:twig` with `--format=json`) and fall back to static config with
`source: "static", incomplete: true` when the console cannot run.

### AST / Refactoring (4)

| Tool                | Description                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **`extract_method`** | Extract complete statements into a new method; rejects unsupported data/control-flow cases    |
| **`rename_symbol`**  | Rename a symbol: PHP structural (one file) / Go·Rust·TS·JS via LSP, applied atomically |
| **`move_class`**     | Move a class-like declaration, preserving declare blocks and referenced `use` imports         |
| **`change_route_path`** | Rewrite `#[Route()]` path arguments project-wide, exact match only, preview writes nothing |

> `extract_method` and the PHP `rename_symbol` path are **pure**: they return the
> generated content and never write to disk. The LSP `rename_symbol` path applies the
> server's `WorkspaceEdit` atomically (with rollback on failure). Git, GitHub and
> GitLab tools live in the separate `four-opencode-git` plugin.

### `batch_edit`

Search and replace across multiple files matching a glob pattern.

**Parameters:**

- `search` (string) — Regex pattern to find
- `replace` (string) — Replacement text ($1, $2 for capture groups)
- `glob` (string) — File pattern (e.g., `src/**/*.ts`)
- `path` (string, optional) — Base directory
- `dry_run` (boolean, optional) — Preview without writing

### `lint_file`

Run appropriate linter on a file and return only errors/warnings. For `.go` files golangci-lint (v2) lints the file's package from the nearest `go.mod`; `govet` and `staticcheck` are part of its standard set. For `.rs` files `cargo clippy --all-targets` lints the crate including tests, benches and examples from the nearest `Cargo.toml`; diagnostic paths are normalised against the Cargo workspace root and filtered to the exact file (no basename matching). For `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files ESLint runs, or `deno lint --json` + `deno check` in a Deno project (`deno.json`/`deno.jsonc`); `typecheck: true` additionally runs `tsc --noEmit -p <nearest tsconfig>` and merges the file's diagnostics with the linter output (`linter: "tsc"` runs only the type-check).

**Parameters:**

- `file_path` (string) — File to lint
- `linter` (string, optional) — `eslint`, `phpstan`, `pint`, `ruff`, `golangci`, `clippy`, `tsc`, `deno`, or `auto`
- `typecheck` (boolean, optional) — Run `tsc --noEmit` for TS/JS files in addition to the linter; ignored for Deno projects

### `run_tests`

Run tests for a specific file and return only failures. In a Go module (`go.mod` in the project directory) it runs `go test` on the package of the given `_test.go` file. In a Cargo crate it runs `cargo test` for `.rs` / `tests/*.rs` files. In a Deno project (`deno.json`/`deno.jsonc`) it runs `deno test` before the Bun/package.json fallback.

**Parameters:**

- `test_file` (string) — Test file to run
- `filter` (string, optional) — Test name pattern
- `framework` (string, optional) — `bun`, `phpunit`, `jest`, `vitest`, `go`, `cargo`, `deno`, or `auto`

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

### `symfony_service`

Look up a Symfony service by id, FQCN, partial id or `tag:<name>`. Returns class,
arguments, tags, alias and decorator chain. Runtime data comes from
`bin/console debug:container --format=json`; without a working console the tool
reads `config/services.(yaml|yml|xml)` and marks the result
`source: "static", incomplete: true`.

**Parameters:** `service` (string, optional), `tag` (string, optional),
`limit` (number, default 20), `directory` (string, optional).

### `symfony_events`

List listeners for an event, sorted by priority. Runtime data comes from
`bin/console debug:event-dispatcher --format=json`; the static fallback uses
`kernel.event_listener` tags and `getSubscribedEvents()` and is marked
`incomplete`.

**Parameters:** `event` (string), `limit` (number, default 50),
`directory` (string, optional).

### `twig_blocks`

Show the Twig override chain for a block name or outline a template and its
`extends` chain. Runtime data comes from
`bin/console debug:twig --format=json`; without a working console the loader paths
and namespaces come from `config/packages/twig.(yaml|yml)` and the result is marked
`incomplete`.

- `mode: "block"` collects every `{% block <name> %}` definition, ordered
  base → derived using the `extends` graph. `parentCall` reports whether the block
  body calls `parent()`.
- `mode: "template"` scans one template plus its ancestors and returns the extends
  chain, block definitions, `use`/`embed`/`include` references and unknown tags.
- Custom inheritance tags are auto-detected from project Twig extensions: a
  `getTokenParsers()` token parser that extends `ExtendsTokenParser`,
  `IncludeTokenParser`, `EmbedTokenParser`, `UseTokenParser` or `BlockTokenParser`
  is mapped to that built-in semantic. Unmapped tags stay unknown and carry a
  hint to map them under `twig.tags`.
- A `templates/bundles/<Bundle>/` override wins over the bundle base for
  `@Bundle/...` names.
- The scanner is tolerant: malformed tags and unknown tags are reported, never
  fatal. References resolve to `path:line`, never file contents.

**Parameters:** `mode` (`block` | `template`, default `block`), `name` (string),
`template` (string, optional — block mode scope), `limit` (number, default 50),
`directory` (string, optional).

### `extract_method`

Extract complete statements from a PHP method into a new method using tree-sitter.

The selection must align with complete statements inside one block. The extracted
method receives every pre-existing variable it reads as an untyped by-reference
parameter, so in-place mutations of caller variables keep working; the call site
passes them back. Static methods use `self::` and a `static` signature.

**Rejected loudly (no silent wrong edit):** partial statements, selections spanning
block boundaries, `return`/`yield`/`goto`, `break`/`continue` that jump out of the
selection (including depth-qualified `break 2`/`continue 2`), `$this` inside a static
method, values assigned in the selection and read afterwards, context-dependent magic
constants (`__METHOD__`, `__FUNCTION__`, `__LINE__`), and method-name collisions.
Collisions are compared case-insensitively, matching PHP method-name rules.

**Parameters:**

- `filePath` (string) — Absolute PHP file path
- `startLine` / `endLine` (number) — 1-based inclusive statement range
- `newMethodName` (string) — Valid PHP method name
- `visibility` (`private` | `protected` | `public`, optional) — Default `private`

### `rename_symbol`

Rename a symbol; the path depends on the file extension.

- `.php` — a declaration and provably same-scope references in **one file**. The
  matching is structural (tree-sitter), with optional line targeting. It is **not**
  semantic cross-file reference resolution: imports and references in other files are
  not updated and a warning says so.
  - Same-class `$this->`, `self::` and `static::` usages are renamed by default.
  - Class/interface/trait/function renames honour `renameUsages: false` too: only the
    declaration changes, and a warning reports the skipped usages.
  - "Provably same-scope" is structural, not semantic: a nested anonymous class is its
    own scope, and same-name members on other objects/classes are counted and reported
    as warnings.
  - Duplicate declarations of the same name are ambiguous: pass `line` to select one.
  - Variable renames require `line` — variables are scope-bound and file-wide matching
    would rename unrelated functions.
  - Free-function renames only update call sites in this file; calls in other files are
    not resolved.
- Go, Rust, TypeScript/JavaScript and any other language with a registered LSP server —
  `textDocument/prepareRename` + `textDocument/rename`, applied as a `WorkspaceEdit`
  atomically (all files or none). Requires the `lsp` module and the matching language
  module (`go`, `rust`, `typescript`). The target position comes from `line` + `column`,
  or `line` + the first `oldName` on it, or the first file occurrence.

**Parameters:**

- `filePath` (string) — Absolute file path
- `oldName` / `newName` (string) — Existing symbol name (leading `$` allowed for PHP
  variables) and the new identifier
- `symbolKind` (string, optional) — PHP only: `class`, `method`, `function`, `variable`,
  `interface`, `trait`, `property` or `constant`
- `line` (number, optional) — 1-based line inside the declaration/target to disambiguate
- `column` (number, optional) — 1-based column hint (requires `line`)
- `preview` (boolean, optional) — PHP: return changes without modified content; LSP: dry run
- `renameUsages` (boolean, optional) — PHP only; default `true`; `false` leaves
  same-scope usages unchanged and reports them as warnings
- `dry_run` (boolean, optional) — LSP path only: compute the edits without writing any file

### `move_class`

Move a class, interface, trait or enum to another file using tree-sitter.

- The source `declare(...)` block is copied verbatim; `strict_types` is never
  injected or upgraded.
- Referenced `use` statements are copied to the target file (unused imports are not).
- The target namespace comes from an explicit `namespace` argument or the nearest
  `composer.json` PSR-4 mapping (`autoload` / `autoload-dev`). If neither yields a
  unique namespace, the operation fails instead of guessing.
- Only top-level class-like declarations are movable; a class declared inside a
  function or conditional is not found and the operation fails.
- An empty PSR-4 prefix maps to the global namespace and does not produce a leading
  backslash. An explicit `namespace: ''` means "global namespace".
- Unresolved short class names that are neither imported nor built in are reported
  as warnings (after a namespace move they would resolve against the new namespace).
- A non-empty target file is never overwritten.

**Parameters:**

- `sourcePath` (string) — Absolute path to the current PHP file
- `className` (string) — Class-like name to move
- `targetPath` (string) — Target PHP file path (absolute or relative to cwd)
- `namespace` (string, optional) — Explicit target namespace

### `change_route_path`

Rewrite the path argument of `#[Route()]` attributes across the project using
tree-sitter.

- AST-based: only `attribute` nodes named `Route` (or ending in `\Route`, e.g. the
  FQCN `#[\Symfony\Component\Routing\Attribute\Route(...)]`) are inspected.
- Only the path argument is rewritten — the first positional argument or a named
  `path:` argument. Single- and double-quoted literals keep their quote style;
  only the characters between the quotes are replaced.
- The value must equal `oldPath` **exactly**. Nothing else changes: no other
  strings, comments, docblocks, method names or attribute arguments.
- A project-wide recursive scan is the point of the tool. It skips `.git`,
  `node_modules`, `vendor`, `var/cache` and `.idea`, inspects `.php` files and is
  bounded by `maxFiles`; an optional explicit `files` list replaces the scan.
- Zero matches is a normal no-op success. Each modified file is re-parsed before
  it is written; a file that cannot be parsed is reported in `failedFiles` and
  left untouched.
- `preview: true` reports changes and writes nothing.

**Parameters:**

- `oldPath` (string) — Exact route path to replace (e.g. `/api/orders`)
- `newPath` (string) — Replacement route path
- `directory` (string, optional) — Scan root; defaults to the tool context directory
- `files` (string[], optional) — Explicit files (absolute or relative to the scan
  root); skips the scan
- `maxFiles` (number, optional) — Cap on scanned PHP files, default `500`
- `preview` (boolean, optional) — Report changes without writing, default `false`

## Modules

Tools are grouped into modules that are selected per project. Configure them in
`opencode.json`:

```json
["@four-bytes/four-opencode-supertools", { "modules": "auto" }]
["@four-bytes/four-opencode-supertools", { "modules": ["core", "lsp", "shopware"] }]
["@four-bytes/four-opencode-supertools", { "disable": ["sonar_search"] }]
```

| Module     | Tools                                         | Auto-detected by                       |
| ---------- | --------------------------------------------- | -------------------------------------- |
| `core`     | 9 file-editing and meta tools                 | always on                              |
| `search`   | `sonar_search`                                | always on in auto mode                 |
| `lsp`      | `file_outline`, `lsp_hover`, `lsp_references`, `lsp_code_action` | always on in auto mode |
| `typescript` | `rename_symbol` (via LSP; tsc/Deno support lives in `lint_file`/`run_tests`) | `tsconfig.json`, `package.json`, `deno.json(c)` |
| `php`      | `extract_method`, `rename_symbol`, `move_class`, `change_route_path` | `composer.json`                      |
| `go`       | `rename_symbol` (via LSP)                     | `go.mod`                               |
| `rust`     | `rename_symbol` (via LSP)                     | `Cargo.toml`                           |
| `symfony`  | `symfony_service`, `symfony_events`, `twig_blocks` | `symfony/framework-bundle` in composer |
| `doctrine` | (later issue)                                 | `doctrine/orm` in composer             |
| `shopware` | (later issue)                                 | `shopware/core` in composer            |

Auto mode always starts with `core`, `search` and `lsp`, then adds `typescript`,
`php`, `go`, `rust`, `symfony`, `doctrine` and `shopware` when their marker is
present in the project directory or worktree. For the framework markers,
`composer.json` means the `require` or `require-dev` section names the package; a
shopware project also counts as symfony and PHP.

Dependencies are resolved transitively: `typescript`, `go` and `rust` require
`lsp`, `symfony` requires `php`, `doctrine` and `shopware` require `symfony`.
`core` is always included, whatever list you pass. `disable` removes individual
tool names after the modules are merged.

To filter tools for a single agent, use opencode's own `tools` config instead of
`disable` — module selection is per project, agent filtering is per agent.

## .supertools.json

Per-project configuration for the framework tools lives in `.supertools.json` at
the project root (the directory holding `composer.json`). The file is optional;
without it the tools use their defaults. It is read per project root and cached
for the process lifetime.

```json
{
  "twig": {
    "tags": {
      "my_tag": "block",
      "another_tag": "include"
    },
    "discovery": {
      "vendor": false,
      "maxFiles": 3000
    }
  }
}
```

`twig.tags` maps a Twig tag name to its kind and overrides auto-detection.
Unknown keys are ignored for forward compatibility. Invalid schemas are reported
with the offending key (for example `twig.tags.my_tag`) and are never silently
dropped. `twig.discovery` controls auto-detection: `vendor` also scans
`<root>/vendor` (default `false`) and `maxFiles` caps the inspected PHP files
(default `3000`). This file is the config base for the Symfony/Shopware tools.

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