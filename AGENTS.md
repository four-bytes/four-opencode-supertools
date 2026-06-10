# AGENTS.md — four-opencode-supertools

## Build & Test Commands

- **Setup**: `mise run setup` or `bun install`
- **Build**: `mise run build` or `bun build ./src/four-opencode-supertools.ts --outdir dist --target bun --format esm --external @opencode-ai/plugin`
- **Test**: `mise run test` or `bun test`
- **Single Test**: `bun test --filter "diff-parse"`
- **Typecheck**: `mise run typecheck` or `tsc --noEmit`
- **Lint**: `mise run lint`
- **Format**: `mise run format`

## Code Style

- TypeScript strict mode, ESNext target, ESM only
- Entry: `src/four-opencode-supertools.ts` (four-opencode convention)
- Build: Bun.build() to dist/, external: @opencode-ai/plugin
- Test: bun test with describe/it/expect
- Format: Prettier (single quotes, 100 width, 2 tab)

## Architecture

- `src/four-opencode-supertools.ts` — Plugin entry, registers tools via `tool:` hook
- `src/tools/apply-patch.ts` — apply_patch tool definition
- `src/lib/diff-parse.ts` — Unified diff parser (extracts hunks)
- `src/lib/diff-apply.ts` — Hunk application engine
- `src/lib/debug-logger.ts` — JSONL debug logger (CC_DEBUG gated)

## Testing

- Use bun test with descriptive test names
- Test diff parsing with real unified diff examples
- Test edge cases: malformed diffs, context mismatches, empty files, new files
