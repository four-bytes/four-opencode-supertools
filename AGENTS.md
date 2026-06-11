# AGENTS.md — four-opencode-supertools

## Build & Test Commands

- **Setup**: `mise run setup` or `bun install`
- **Build**: `mise run build` or `bun build ./src/four-opencode-supertools.ts --outdir dist --target bun --format esm --external @opencode-ai/plugin`
- **Test**: `mise run test` or `bun test`
- **Single Test**: `bun test --filter "diff-parse"` or `bun test --filter "batch-edit"`
- **Typecheck**: `mise run typecheck` or `tsc --noEmit`
- **Lint**: `mise run lint`
- **Format**: `mise run format`

## Code Style

- TypeScript strict mode, ESNext target, ESM only
- Entry: `src/four-opencode-supertools.ts` (four-opencode convention)
- Build: Bun.build() to dist/, external: @opencode-ai/plugin
- Test: bun test with describe/it/expect
- Format: Prettier (single quotes, 100 width, 2 tab, semicolons)

## Architecture

```
src/
├── four-opencode-supertools.ts    # Plugin entry — registers all 18 tools
├── tools/
│   ├── apply-patch.ts             # Unified diff patch application (~90% token savings)
│   ├── batch-edit.ts              # Multi-file search and replace (~80%)
│   ├── lint-file.ts               # Single-file linting (~60%)
│   └── run-tests.ts               # Targeted test execution (~50%)
│   ├── curse-score.ts             # File risk ranking (~80%)
│   ├── bus-factor.ts              # Ownership concentration (~80%)
│   ├── implicit-coupling.ts       # Co-change dependencies (~85%)
│   ├── ownership.ts               # Author breakdown (~80%)
│   ├── git-diff.ts                # Structured git diff output (~90%)
│   └── blast-radius.ts            # Impact analysis (~85%)
│   ├── trend.ts                   # Curse score trend analysis (~90%)
│   ├── pr-risk.ts                 # PR risk assessment (~90%)
│   └── git-log-structured.ts      # Structured git log (~50%)
│   ├── gh-issue-list.ts           # GitHub issue list with filters (~90%)
│   ├── gh-issue-close.ts          # Close issue + zombie detection (~90%)
│   ├── gh-pr-status.ts            # PR mergeability check (~90%)
│   ├── gh-branch-cleanup.ts       # Stale merged branch cleanup (~90%)
│   └── gh-release-info.ts         # Structured release metadata (~90%)
└── lib/
    ├── diff-parse.ts              # Unified diff parser
    ├── diff-apply.ts              # Hunk application engine
    ├── debug-logger.ts            # JSONL debug logger (CC_DEBUG gated)
    └── git-utils.ts               # Shared git utilities (run, log, blame, file list)
    ├── gh-utils.ts                # Shared gh CLI utilities (run, repo resolution) (run, log, blame, file list)
```

## Tools Reference

| Tool          | Token Savings | Description                                             |
| ------------- | ------------- | ------------------------------------------------------- |
| `apply_patch` | ~90%          | Apply unified diff patch to a file                      |
| `batch_edit`  | ~80%          | Search and replace across multiple files                |
| `lint_file`   | ~60%          | Run linter, return errors only                          |
| `run_tests`   | ~50%          | Run tests, return failures only                         |
| `git_diff`    | ~90%          | Structured git diff output (staged, file, between refs) |
| `trend`       | ~90%          | Curse score trends — files getting more dangerous      |
| `pr_risk`     | ~90%          | Risk assessment of uncommitted changes                 |
| `git_log_structured` | ~50%   | Structured git log with filters                        |
| `gh_issue_list`      | ~90%  | List GitHub issues with filtering                       |
| `gh_issue_close`     | ~90%  | Close issue with zombie detection + comment             |
| `gh_pr_status`       | ~90%  | PR mergeability check (reviews, CI, conflicts)          |
| `gh_branch_cleanup`  | ~90%  | Find + delete stale merged remote branches              |
| `gh_release_info`    | ~90%  | Structured release metadata (version, tag, notes)                        |

## Testing

- Use bun test with descriptive test names
- Test each tool with real file operations in tmp directories
- Test edge cases: missing files, invalid patterns, empty outputs
- Clean up tmp files after each test

## Standards

- Apache-2.0 license
- Conventional commits (feat:, fix:, docs:, test:)
- ROADMAP.md for evolution planning
- GUIDELINES.md for coding standards
