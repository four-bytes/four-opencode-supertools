# four-opencode-supertools — Evolution Roadmap

> ⚠️ This roadmap is aligned with the canonical meta-repo roadmap at `four-opencode-plugins/ROADMAP.md`. In case of conflict, the meta-repo takes precedence.
>
> Token-efficient supertools for opencode agents. Save tokens, ship faster.

## Wave S1 — `apply_patch` ✅

> DONE. Unified diff patch application saving ~90% tokens vs full-file write.

| Task                                              | Status |
| ------------------------------------------------- | ------ |
| Diff parser (standard unified format)             | ✅     |
| Hunk application engine                           | ✅     |
| Context validation (preflight mismatch detection) | ✅     |
| New file creation via @@ -0,0                     | ✅     |
| 19 tests across 3 test files                      | ✅     |

> **Note:** `apply_patch` is kept in supertools for now. The native opencode `patch` tool is equivalent — supertools will deprecate this wrapper once opencode ships the native tool universally.

## Wave S2 — Core Tool Suite ✅

> DONE. Three additional token-saving tools: batch_edit, lint_file, run_tests.

### S2.1 — `batch_edit` (grep→replace across N files)

- [x] Search files by regex + file glob
- [x] Read matching files, apply replacement
- [x] Write back changed files atomically
- [x] Return summary: files changed, replacements per file
- [x] Preflight: validate regex compiles, glob finds files
- [x] Token savings: ~80% (one call vs grep→read→edit×N)

### S2.2 — `lint_file` (run linter, return errors only)

- [x] Auto-detect linter by file extension
- [x] Support: eslint (.ts/.js), phpstan/pint (.php), ruff (.py)
- [x] Run linter on single file, parse output
- [x] Return: error count, warning count, formatted errors
- [x] Token savings: ~60% (no bash→read→parse)

### S2.3 — `run_tests` (run tests, return failures only)

- [x] Auto-detect test framework from project config
- [x] Support: bun test, phpunit, jest/vitest
- [x] Run specific file (optional test name filter)
- [x] Parse output, return only failures
- [x] Token savings: ~50% (no bash→read→parse 2000 lines of output)

### Acceptance Criteria (S2)

- [x] All 3 tools have tool definitions in `src/tools/`
- [x] Each tool has tests in `tests/`
- [x] Plugin entry registers all 4 tools
- [x] `bun test` passes (existing 19 + new tests)
- [x] `tsc --noEmit` passes

## Wave S3 — Open-Source Readiness ✅

> DONE. README, CONTRIBUTING.md, GUIDELINES.md, issue/PR templates, CI/CD all in place.

### Tasks

#### S3.1 — README.md

- [x] Project description
- [x] Tool reference table
- [x] Installation guide
- [x] Configuration docs
- [x] Requirements

#### S3.2 — CONTRIBUTING.md

- [x] Full contributing guide following four-opencode-brain pattern

#### S3.3 — GUIDELINES.md

- [x] Coding standards and conventions

#### S3.4 — GitHub Templates

- [x] `.github/ISSUE_TEMPLATE/bug_report.md`
- [x] `.github/ISSUE_TEMPLATE/feature_request.md`
- [x] `.github/PULL_REQUEST_TEMPLATE.md`

#### S3.5 — CI/CD

- [x] `.github/dependabot.yml`
- [x] `.github/workflows/codeql.yml`

### Acceptance Criteria (S3)

- [x] README is complete and welcoming
- [x] CONTRIBUTING.md covers full workflow
- [x] Issue templates guide quality reports
- [x] Repository looks professional and discoverable

---

## Wave S4 — Git Extraction ⏳

> **Migrating to `four-opencode-git`.** All git/GitHub/GitLab tools are being extracted into the new standalone `four-opencode-git` plugin. After migration, supertools retains only lean file/code/research tools. See meta-repo ROADMAP.md Wave G for full plan.

### Tools Moving to `four-opencode-git`

All 19 tools below will be migrated to `four-opencode-git` (Wave G in meta-repo):

| Tool | Description | Meta-repo Wave G |
| --- | --- | --- |
| `git_diff` | Structured git diff output (staged, file, between refs) | G1 |
| `git_log_structured` | Structured git log with author/date/file filters | G1 |
| `curse_score` | Rank files by risk via curse score algorithm | G1 → `git_analyze` |
| `bus_factor` | Ownership concentration per directory | G1 → `git_analyze` |
| `implicit_coupling` | Hidden co-change dependencies | G1 → `git_analyze` |
| `ownership` | Author breakdown per file/directory | G1 → `git_analyze` |
| `blast_radius` | Impact analysis — what might break? | G1 → `git_analyze` |
| `trend` | Curse score trend analysis | G1 → `git_analyze` |
| `pr_risk` | Risk assessment of uncommitted changes | G1 → `git_analyze` |
| `gh_pr_create` | Create GitHub pull request | G1 |
| `gh_pr_comment` | Add comment to PR | G1 |
| `gh_pr_review` | Fetch PR review comments and state | G1 |
| `gh_pr_status` | PR mergeability check (reviews, CI, conflicts) | G1 |
| `gh_issue_list` | List issues with filtering (label, assignee, state) | G1 |
| `gh_issue_close` | Close issue with zombie detection + optional comment | G1 |
| `gh_branch_cleanup` | Find + delete stale merged remote branches | G1 |
| `gh_release_info` | Structured release metadata | G1 |
| `gh_bot_review` | Parse AI bot reviews on PR (CodeRabbit, cubic-dev) | G1 |
| `gitlab_mr_create` | Create GitLab merge request | G1 |
| `gitlab_mr_comment` | Add comment to MR | G1 |
| `gitlab_mr_status` | Check MR state/mergeability/pipelines | G1 |

### New `git_analyze` Dispatcher (replaces 7 individual tools)

> Wave G introduces `git_analyze(metric, args)` — a single dispatcher that collapses 7 analysis tools into 1 schema. Reduces tool schema overhead per request while keeping all functionality accessible.

| Routed metric | Original tool | Args |
| --- | --- | --- |
| `curse_score` | `curse_score` | `file?, since?` |
| `bus_factor` | `bus_factor` | `path?, since?` |
| `implicit_coupling` | `implicit_coupling` | `threshold?, since?` |
| `ownership` | `ownership` | `path?` |
| `blast_radius` | `blast_radius` | `file?, since?` |
| `trend` | `trend` | `top?, window_days?` |
| `pr_risk` | `pr_risk` | — |

**Dev:** `src/tools/git-analyze.ts` in `four-opencode-git`. Import execute functions from each analysis module. Route by `metric` string. Pass remainder of args to routed function.

### Tools Remaining in Supertools

After extraction, supertools keeps these 4 tools:

| Tool | Reason |
| --- | --- |
| `batch_edit` | grep→replace across N files, no equivalent in opencode core |
| `lint_file` | Linter wrapper with structured output, no opencode equivalent |
| `run_tests` | Test runner with failure parsing, no opencode equivalent |
| `append_file` | Append/prepend to files, distinct from patch/edit |

### Removal

| Tool | Reason |
| --- | --- |
| `patch_file` | **DELETE** — identical to native opencode `patch` tool, pure duplication |

### Source

See [meta-repo ROADMAP.md — Wave G](https://github.com/four-bytes/four-opencode-plugins/blob/main/ROADMAP.md#wave-g--git-plugin-new).

---

## Wave S5 — Supertools Redesign ⏳

> **New tools after git extraction.** Supertools becomes a lean file/code/research toolkit. See meta-repo ROADMAP.md Wave S for full plan.

### S5.1 — `smart_edit` — fuzzy string replace

- **Gap:** native `edit` fails on whitespace/indentation variance; `patch` needs exact line numbers
- **Args:** `file_path: string, old_string: string, new_string: string, allow_multiple?: boolean`
- **Logic:** exact match first → normalized whitespace retry → if `allow_multiple=false` and >1 match: error with line numbers
- **Returns:** `{ changed: true, line: number, preview: string }` | `{ error: string, candidates?: number[] }`

### S5.2 — `smart_patch` — context-anchored patch (ignores line numbers)

- **Gap:** native `patch` rejects if `@@ -N @@` line number is off by even a few lines — agents miscounting or working from stale reads causes constant failures
- **Args:** `file_path: string, patch: string, fuzz?: number (default 3)`
- **Logic:** parse unified diff; ignore `@@ -N @@` line numbers; scan file for best context match; accept if mismatches ≤ `fuzz`; apply hunk at found position
- **Returns:** `{ applied: true, hunks: number, offsets: number[] }` | `{ error: string, hunk: number, context: string[] }`

### S5.3 — `batch_patch` — multi-file patch in one call

- **Gap:** native `patch` is single-file; coordinated multi-file changes require N round trips
- **Args:** `patches: Array<{ file_path: string, patch: string }>, atomic?: boolean`
- **Logic:** parse all patches (fail-fast); if `atomic=true`: snapshot → apply → rollback on failure; if `atomic=false`: best-effort
- **Returns:** `{ applied: string[], failed: Array<{ file: string, error: string }> }` | adds `rolled_back: string[]` on atomic rollback

### S5.4 — `file_tree` — structured directory listing

- **Gap:** agents use `bash ls -R` or `find` — verbose, hard to parse, no size info
- **Args:** `path: string, depth?: number (default 3), filter?: string (glob), include_hidden?: boolean (default false)`
- **Logic:** walk recursively to depth; skip `.git`, `node_modules`, `vendor` unless `include_hidden=true`; apply glob filter; respect `.gitignore`
- **Returns:** `{ name: string, type: "file"|"dir", size?: number, children?: [...] }[]`

### S5.5 — `research` — brain + web in one call

- **Gap:** agents do `brain_search` + separate `websearch` + `webfetch` = 3+ round trips
- **Args:** `queries: string[], scope?: "brain" | "web" | "both" (default "both")`
- **Logic:** run in parallel per query: brain via `ctx.callTool("brain_search", { query })`, web via native websearch; merge + deduplicate
- **Returns:** `Array<{ query: string, brain: Result[], web: Result[] }>`

### S5.6 — `solution_confidence` — verification scoring

- **Gap:** no structured way to verify a fix beyond "tests pass"
- **Args:** `description: string, evidence?: string[]`
- **Logic:** `run_tests` (detect test files via glob on description keywords) → `brain_search` for matching KB patterns (score > 0.7 + `review_state === "accepted"`) → `pr_risk` on staged changes if git available → weighted score: tests(0.4) + kb_match(0.3) + coverage(0.3)
- **Returns:** `{ confidence: number, verdict: "likely_fixed" | "uncertain" | "band_aid", risks: string[], checks: { tests: bool|null, kb_match: bool|null, coverage: bool|null } }`

---

## Wave S6 — IDE Integration 🚧

> LSP-powered tools for smarter code operations.

| Tool              | Description                              | Status      |
| ----------------- | ---------------------------------------- | ----------- |
| `lsp_hover`       | Get type info / documentation for symbol | 🚧 WIP     |
| `lsp_references`  | Find all references to symbol            | 🚧 In PR   |
| `lsp_diagnostics` | Get diagnostics for file/project         | 🚧 WIP     |

**Note:** All S6 tools depend on the `LspClient` library (`src/lib/lsp-client.ts`) and `LspRegistry` (`src/lib/lsp-registry.ts`). The shared lib is in PR #29 (feat/28-lsp-client merged). References tool in PR #33. Hover + diagnostics pending PR.

---

## Wave S7 — Search & Patch Tools ⏳

> Planned. Multi-file search tools and PDF generation.

### S7.1 — `grep_patch` (recursive grep + apply patches)
- [ ] Search directories by regex, apply patches to all matching files
- [ ] Dry-run mode to preview changes
- [ ] Token savings: ~85% (vs. grep→read×N→patch×N)

### S7.2 — `grep_filelist` (file-list only output)
- [ ] Run grep, return only matching file paths (no content lines)
- [ ] Reduces token output by ~90% for broad searches
- [ ] Token savings: ~90%

### S7.3 — `md_to_pdf` (Markdown → PDF)
- [ ] Convert markdown to PDF via pandoc → weasyprint
- [ ] Four-Flames CSS branding (red #c0392b accents, dark blue #2c3e50 tables)
- [ ] Support code blocks, tables, headings, unicode bar charts

---

## Wave S8 — DevOps Tools ⏳

> Planned. Infrastructure-as-code and secrets management.

### S8.1 — SOPS encryption
- [ ] `sops_encrypt` / `sops_decrypt` tools
- [ ] Support age, GPG, AWS KMS, GCP KMS
- [ ] Structured output with key info

### S8.2 — Terraform tools
- [ ] `terraform_plan`, `terraform_apply`, `terraform_state` tools
- [ ] Workspace management
- [ ] Plan summary output (saves ~95% tokens vs raw plan)

### S8.3 — Ansible tools
- [ ] `ansible_playbook` — execute playbooks with inventory
- [ ] `ansible_inventory` — list/manage inventory
- [ ] Structured output with task results

### S8.4 — Helm tools
- [ ] `helm_install`, `helm_upgrade`, `helm_list`, `helm_uninstall`
- [ ] Chart repository management
- [ ] Release status output

### S8.5 — SSH tools (spec later)
- [ ] SSH login with key/agent support
- [ ] Jump host / ProxyJump support
- [ ] Auto-mask sensitive data in command output
- [ ] Remember CWD across commands (session state)

---

## Wave S9 — Documentation ⏳

> Planned. README update to match meta-repo standard.

- [ ] Update README.md to follow `README_TEMPLATE.md`
- [ ] Add config samples for all tools
- [ ] Add per-tool parameter tables

---

## Status

| Wave | Status         |
| ---- | -------------- |
| S1   | ✅ Done        |
| S2   | ✅ Done        |
| S3   | ✅ Done        |
| S4   | ⏳ Planned (Git Extraction → four-opencode-git) |
| S5   | ⏳ Planned (Supertools Redesign) |
| S6   | 🚧 In Progress |
| S7   | ⏳ Planned     |
| S8   | ⏳ Planned     |
| S9   | ⏳ Planned     |

## Execution Order

```
S1 ✅ → S2 ✅ → S3 ✅ → S4 ⏳ (Git Extraction) → S5 ⏳ (Redesign) → S6 🚧 → S7 ⏳ → S8 ⏳ → S9 ⏳
```

Waves S1–S3 complete. S4 (Git Extraction) and S5 (Supertools Redesign) follow meta-repo Wave G + Wave S. S6 in progress, S7–S9 planned.
