# four-opencode-supertools — Evolution Roadmap

> Token-efficient supertools for opencode agents. Save tokens, ship faster.

## Wave Ordering

```
S1 (apply_patch) → S2 (batch_edit + lint_file + run_tests) → S3 (open-source readiness) → S4 (git intelligence) → S5 (smart_read + advanced tools) → S6 (IDE integration)
```
S1 (apply_patch) → S2 (batch_edit + lint_file + run_tests) → S3 (open-source readiness) → S4 (git intelligence) → S5 (github_ops) → S6 (IDE integration)
```
## Wave S1 — `apply_patch` ✅

> DONE. Unified diff patch application saving ~90% tokens vs full-file write.

| Task                                              | Status |
| ------------------------------------------------- | ------ |
| Diff parser (standard unified format)             | ✅     |
| Hunk application engine                           | ✅     |
| Context validation (preflight mismatch detection) | ✅     |
| New file creation via @@ -0,0                     | ✅     |
| 19 tests across 3 test files                      | ✅     |

## Wave S2 — Core Tool Suite 🔄

> IN PROGRESS. Three additional token-saving tools.

### S2.1 — `batch_edit` (grep→replace across N files)

- [ ] Search files by regex + file glob
- [ ] Read matching files, apply replacement
- [ ] Write back changed files atomically
- [ ] Return summary: files changed, replacements per file
- [ ] Preflight: validate regex compiles, glob finds files
- [ ] Token savings: ~80% (one call vs grep→read→edit×N)

### S2.2 — `lint_file` (run linter, return errors only)

- [ ] Auto-detect linter by file extension
- [ ] Support: eslint (.ts/.js), phpstan/pint (.php), ruff (.py)
- [ ] Run linter on single file, parse output
- [ ] Return: error count, warning count, formatted errors
- [ ] Token savings: ~60% (no bash→read→parse)

### S2.3 — `run_tests` (run tests, return failures only)

- [ ] Auto-detect test framework from project config
- [ ] Support: bun test, phpunit, jest/vitest
- [ ] Run specific file (optional test name filter)
- [ ] Parse output, return only failures
- [ ] Token savings: ~50% (no bash→read→parse 2000 lines of output)

### Acceptance Criteria (S2)

- [ ] All 3 tools have tool definitions in `src/tools/`
- [ ] Each tool has tests in `tests/`
- [ ] Plugin entry registers all 4 tools
- [ ] `bun test` passes (existing 19 + new tests)
- [ ] `tsc --noEmit` passes

## Wave S3 — Open-Source Readiness

> Priority: HIGH. Required before public announcement.

### Tasks

#### S3.1 — README.md

- [x] Project description
- [x] Tool reference table
- [ ] Installation guide
- [ ] Configuration docs
- [ ] Requirements

#### S3.2 — CONTRIBUTING.md

- [ ] Full contributing guide following four-opencode-brain pattern

#### S3.3 — GUIDELINES.md

- [ ] Coding standards and conventions

#### S3.4 — GitHub Templates

- [ ] `.github/ISSUE_TEMPLATE/bug_report.md`
- [ ] `.github/ISSUE_TEMPLATE/feature_request.md`
- [ ] `.github/PULL_REQUEST_TEMPLATE.md`

#### S3.5 — CI/CD

- [ ] `.github/dependabot.yml`
- [ ] `.github/workflows/codeql.yml`

### Acceptance Criteria (S3)

- [ ] README is complete and welcoming
- [ ] CONTRIBUTING.md covers full workflow
- [ ] Issue templates guide quality reports
- [ ] Repository looks professional and discoverable

## Wave S4 — Git Intelligence ✅

> DONE. Five git-history risk analytics tools. Surface hidden risks, knowledge silos, and co-change dependencies.

| Tool                | Token Savings | Description                                  |
| ------------------- | ------------- | -------------------------------------------- |
| `curse_score`       | ~80%          | Rank files by risk via curse score algorithm |
| `bus_factor`        | ~80%          | Ownership concentration per directory        |
| `implicit_coupling` | ~85%          | Hidden co-change dependencies                |
| `ownership`         | ~80%          | Author breakdown per file/directory          |
| `blast_radius`      | ~85%          | Impact analysis — what might break?          |
| `git_diff`          | ~90%          | Get structured git diff output               |
| `trend`             | ~90%          | Curse score trends — files getting worse     |
| `pr_risk`           | ~90%          | Risk assessment of uncommitted changes       |
| `git_log_structured`| ~50%          | Structured git log with filters              |

### Tasks

- [x] `curse_score` — changes × author chaos × recency × churn acceleration
- [x] `bus_factor` — git blame-based directory ownership concentration
- [x] `implicit_coupling` — co-commit pair detection via git log --numstat
- [x] `ownership` — per-file/per-directory author line count breakdown
- [x] `blast_radius` — coupled files + author-related impact analysis
- [x] `git-runner` — safe git subprocess spawning with error handling
- [x] `git-log-parser` — structured commit + file change parsing
- [x] `git-blame-parser` — porcelain blame output parsing
- [x] `git_diff` — structured git diff output (staged, file, between refs)
- [x] `trend` — curse score trend analysis comparing two time windows
- [x] `pr_risk` — uncommitted change risk assessment (curse + coupling + bus factor)
- [x] `git_log_structured` — structured git log with author/date/file filters
- [x] 30 tests in `tests/git-tools.test.ts` + `tests/git-diff.test.ts`

## Wave S5 — GitHub Ops ✅

> DONE. GitHub CLI wrapper tools. Wrap `gh` CLI commands as structured JSON-output tools. Saves ~90% tokens vs. bash→read→parse. Replaces reliance on the `@github` subagent for common ops.

| Tool                | Token Savings | Description                                              |
| ------------------- | ------------- | -------------------------------------------------------- |
| `gh_issue_list`     | ~90%          | List open issues with filtering (label, assignee, state) |
| `gh_issue_close`    | ~90%          | Close issue with zombie detection + optional comment     |
| `gh_pr_status`      | ~90%          | PR mergeability check (reviews, CI, conflicts)           |
| `gh_branch_cleanup` | ~90%          | Find + delete stale merged remote branches               |
| `gh_release_info`   | ~90%          | Structured release metadata (version, tag, notes, assets)|

Source: [four-opencode-plugins ROADMAP Wave S5](https://github.com/four-bytes/four-opencode-plugins/blob/main/ROADMAP.md)

## Wave S6 — IDE Integration

> Future. LSP-powered tools for smarter code operations.

### Candidates

| Tool              | Description                              |
| ----------------- | ---------------------------------------- |
| `lsp_hover`       | Get type info / documentation for symbol |
| `lsp_references`  | Find all references to symbol            |
| `lsp_diagnostics` | Get diagnostics for file/project         |

---

## Status

| Wave | Status         |
| ---- | -------------- |
| S1   | ✅ Done        |
| S2   | 🔄 In Progress |
| S3   | 🔄 In Progress |
| S4   | ✅ Done        |
| S5   | ✅ Done        |
| S6   | ⏳ Planned     |

## Execution Order

```
S1 ✅ → S2 🔄 → S3 🔄 → S4 ✅ → S5 → S6
```

S3 runs in parallel with S2.
