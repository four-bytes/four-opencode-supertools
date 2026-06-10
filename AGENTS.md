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
├── four-opencode-supertools.ts    # Plugin entry — registers all 9 tools
├── tools/
│   ├── apply-patch.ts             # Unified diff patch application (~90% token savings)
│   ├── batch-edit.ts              # Multi-file search and replace (~80%)
│   ├── lint-file.ts               # Single-file linting (~60%)
│   └── run-tests.ts               # Targeted test execution (~50%)
│   ├── curse-score.ts             # File risk ranking (~80%)
│   ├── bus-factor.ts              # Ownership concentration (~80%)
│   ├── implicit-coupling.ts       # Co-change dependencies (~85%)
│   ├── ownership.ts               # Author breakdown (~80%)
│   └── blast-radius.ts            # Impact analysis (~85%)
└── lib/
    ├── diff-parse.ts              # Unified diff parser
    ├── diff-apply.ts              # Hunk application engine
    ├── debug-logger.ts            # JSONL debug logger (CC_DEBUG gated)
    ├── git-runner.ts              # Safe git subprocess spawning
    ├── git-log-parser.ts          # Structured git log parsing
    └── git-blame-parser.ts        # Porcelain git blame parsing
```

## Tools Reference

| Tool | Token Savings | Description |
|------|---------------|-------------|
| `apply_patch` | ~90% | Apply unified diff patch to a file |
| `batch_edit` | ~80% | Search and replace across multiple files |
| `lint_file` | ~60% | Run linter, return errors only |
| `run_tests` | ~50% | Run tests, return failures only |

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
