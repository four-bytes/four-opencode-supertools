# Git Intelligence Tools — Implementation Spec

**Handoff to:** Developer  
**Status:** 5 stubs merged into supertools (`src/tools/curse-score.ts` etc.)  
**Reference:** [git-archaeologist](https://github.com/SushantVerma7969/git-archaeologist) (MIT)  
**Plugin:** `@four-bytes/four-opencode-supertools` v0.2.0 → v0.3.0  
**Wave:** P14 (merged into supertools)

---

## Architecture

All git tools live in `src/tools/` alongside existing supertools. Each tool is a separate file, imported and registered in `src/four-opencode-supertools.ts`.

### File Structure (after implementation)

```
src/tools/
├── apply-patch.ts         # existing
├── batch-edit.ts          # existing
├── lint-file.ts           # existing
├── run-tests.ts           # existing
├── curse-score.ts         # NEW — implement
├── bus-factor.ts          # NEW — implement
├── implicit-coupling.ts   # NEW — implement
├── ownership.ts           # NEW — implement
└── blast-radius.ts        # NEW — implement (depends on coupling + ownership)
src/lib/
├── debug-logger.ts        # existing
├── diff-parse.ts          # existing
├── diff-apply.ts          # existing
└── git-utils.ts           # NEW — shared git helpers
tests/
├── curse-score.test.ts    # NEW
├── bus-factor.test.ts     # NEW
├── implicit-coupling.test.ts  # NEW
├── ownership.test.ts      # NEW
└── blast-radius.test.ts   # NEW
```

### Shared Library: `src/lib/git-utils.ts`

Create a shared utility module to avoid duplicating git command execution across tools:

```typescript
// Functions to extract:
// - runGit(args: string[], cwd: string): Promise<string>  — run git, return stdout
// - parseGitLog(cwd: string, since?: string): Promise<GitLogEntry[]>
// - getFileList(cwd: string): string[]  — ls-files excluding lockfiles/changelogs
// - isExcluded(file: string): boolean  — filter lockfiles, changelogs, CI configs, dist/
```

**Excluded file patterns** (inherited from git-archaeologist):
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb`
- `CHANGELOG.md`, `HISTORY.md`, `*.changelog*`
- `.github/workflows/*.yml`, `.github/dependabot.yml`
- `dist/**`, `node_modules/**`, `.git/**`
- `*.min.js`, `*.min.css`

### Execution Pattern (all tools follow this)

```typescript
import { tool } from '@opencode-ai/plugin';
import { logDebugEvent } from '../lib/debug-logger';
import { runGit } from '../lib/git-utils';

export const myTool = tool({
  description: `...`,
  args: {
    param1: tool.schema.string().describe('...'),
  },
  async execute(args, ctx) {
    const directory = ctx.directory;  // repo root
    logDebugEvent('myTool.start', { ...args });
    try {
      // 1. Run git commands via Bun shell
      const output = await runGit(['log', '--format=...'], directory);
      // 2. Parse and compute
      // 3. Return formatted string result
      logDebugEvent('myTool.complete', { ... });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logDebugEvent('myTool.error', { error: msg });
      return `Error: ${msg}`;
    }
  },
});
```

### Git Execution

Use `Bun.spawn` for git commands (consistent with `run-tests.ts` pattern):

```typescript
async function runGit(args: string[], cwd: string, timeout = 30000): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (proc.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout;
}
```

**Key:** Always use `Bun.spawn` (NOT `Bun.$`) for git commands — `Bun.$` can hang on large outputs from `git log`.

---

## Tool 1: `curse_score`

### Algorithm
```
curse_score = changes × log₂(authors + 1) × exp(-0.5 × age_years) × log₂(churn_rate + 2) × acceleration
```

Where:
- **changes** = total number of commits touching this file
- **authors** = unique author count
- **age_years** = years since first commit (decay makes old-stable files score lower)
- **churn_rate** = changes / time_window_years (higher churn = higher risk)
- **acceleration** = changes_in_last_quarter / changes_overall (recent activity multiplier, capped at 3.0)

### Git Commands
```bash
# Get all file changes with stats
git log --format='%H %an %ai' --numstat -- .

# Alternative: faster for large repos
git log --format='%H %an %ai' --name-only -- .
```

### Parse into per-file stats
```
For each commit:
  - Extract: hash, author, date
  - For each file in numstat: increment change_count, track author uniqueness, track dates
  
For each file:
  - changes = commit count
  - authors = unique author names
  - first_date = earliest commit date
  - last_date = latest commit date
  - age_years = (now - first_date) / 365.25
  - churn_rate = changes / max(age_years, 0.25)
  - acceleration = min(changes_in_last_90d / max(changes, 1), 3.0)
  - score = changes * log2(authors + 1) * exp(-0.5 * age_years) * log2(churn_rate + 2) * acceleration
```

### Parameters
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `top` | number | 10 | Number of files to return |
| `since` | string | — | Time filter: `90d`, `6m`, `1y`, `2024-01-01` |

### Output Format
```
CURSE SCORE — top 10 files by risk
  1. src/core/handler.ts     score 2242   12 authors   53 changes   churn 17.7/yr
  2. lib/router/index.ts     score 1891    8 authors   41 changes   churn 13.6/yr
  3. ...
```

### Edge Cases
- Empty repo (no commits) → "No git history found"
- Single commit → all files have same age, score driven by authors+changes only
- Binary files → skip (no numstat data)
- Renamed files → `git log --follow` for accurate history
- `since` parsing: accept `\d+[dmy]` and `YYYY-MM-DD` formats

### Test Data
Create mock `git log` output strings for:
- 3 files, 5 commits, 2 authors → verify scoring
- Single commit → verify no division by zero
- Empty output → verify graceful message
- Excluded file → verify it's filtered out

---

## Tool 2: `bus_factor`

### Algorithm
```
For each directory:
  ownership_pct = (top_author_changes / total_directory_changes) × 100
  bus_factor = 1 if ownership_pct > 70%
  bus_factor = 2 if ownership_pct > 50%
  bus_factor = 3+ otherwise
```

### Git Commands
```bash
# Get all file changes
git log --format='%H %an' --numstat -- .

# For each directory, aggregate author change counts
```

### Output Format
```
BUS FACTOR — per-directory ownership
  lib/        → 1  (dougwilson owns 71% of changes)
  src/core/   → 1  (alice owns 82% of changes)  
  tests/      → 2  (bob 55%, alice 45%)
  docs/       → 3+
```

### Parameters
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `since` | string | — | Time filter |

### Edge Cases
- Monorepo with single top-level dir → report meaningful subdirectories
- Author with multiple emails → normalize (match by name)
- Directory with < 5 commits → mark as "insufficient data"

---

## Tool 3: `implicit_coupling`

### Algorithm
```
For all file pairs (A, B):
  co_commits = count of commits containing BOTH A and B
  a_commits = count of commits containing A
  b_commits = count of commits containing B
  coupling = co_commits / max(a_commits, b_commits)
  
Return pairs where coupling >= threshold, sorted by coupling descending.
Limit to top 50 pairs to avoid O(n²) output.
```

### Git Commands
```bash
# Get file lists per commit
git log --format='%H' --name-only -- .
```

### Optimization
For repos with >1000 files, sample the most-changed 500 files to keep computation reasonable:
```bash
git log --format= --name-only -- . | sort | uniq -c | sort -rn | head -500
```

### Output Format
```
IMPLICIT COUPLING — files that change together (threshold: 0.80)
  benchmarks/Makefile ↔ benchmarks/run        1.00 (12 co-commits)
  src/auth/login.ts  ↔ src/auth/session.ts    0.92 (11/12 co-commits)
  ...
```

### Parameters
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `threshold` | number | 0.8 | Minimum coupling rate (0.0–1.0) |
| `since` | string | — | Time filter |

### Edge Cases
- Single file in repo → "Not enough files for coupling analysis"
- All files change in every commit → all pairs score 1.0 (monorepo with PR squashing)
- Very large repo → sample top 500 files only, note truncation in output

---

## Tool 4: `ownership`

### Algorithm
```
For each file (or directory):
  Run git blame --line-porcelain
  Aggregate: author → line_count
  Compute: author_pct = line_count / total_lines × 100
  Flag: knowledge_silo = any author > 80%
```

### Git Commands
```bash
# Per-file
git blame --line-porcelain <file>

# Per-directory (run for each file, aggregate)
for f in $(git ls-files <dir>); do git blame --line-porcelain "$f"; done
```

**Note:** `--line-porcelain` outputs one `author` line per line of code. Parse the `author` field only.

### Output Format
```
OWNERSHIP — src/core/handler.ts (312 lines)
  dougwilson    187 lines (59.9%)
  alice          89 lines (28.5%)
  bob            36 lines (11.5%)
  ⚠ dougwilson owns <80% — no knowledge silo

OWNERSHIP — lib/ (1,247 lines across 8 files)
  dougwilson  1,023 lines (82.0%)  ⚠ KNOWLEDGE SILO
  alice         224 lines (18.0%)
```

### Parameters
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `.` | File or directory path relative to repo root |

### Edge Cases
- Binary file → "Cannot analyze binary file"
- Empty file → "File has no lines"
- Path doesn't exist → "Path not found: ..."
- Directory with 0 source files → "No source files in directory"

---

## Tool 5: `blast_radius`

### Algorithm
```
Given file F:
1. Find implicitly coupled files (reuse coupling logic, threshold 0.5)
2. Find files with same dominant author (reuse ownership logic)
3. Find files in same directory changed in last 90 days
4. Compute risk_score for each related file:
   risk = (coupling_strength × 0.5) + (author_overlap × 0.3) + (directory_proximity × 0.2)
5. Return combined report, sorted by risk_score
```

### Git Commands
Uses internal coupling and ownership data (no additional git commands beyond what those tools run).

### Output Format
```
BLAST RADIUS — src/core/handler.ts
  Risk score | File                          | Reason
  0.92       | src/core/middleware.ts        | coupling (0.88) + shared author (dougwilson)
  0.78       | src/core/router.ts            | coupling (0.75) + same directory
  0.65       | lib/response.ts               | shared author (dougwilson, 82% owner)
  0.42       | src/core/validator.ts         | same directory
```

### Parameters
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `file` | string | — | **Required.** File path relative to repo root |
| `since` | string | — | Time filter |

### Edge Cases
- File not in repo → "File not found: ..."
- File with no git history → "No history for this file"
- File with no coupling → report only shared-author and directory-proximity results

---

## Implementation Order (Dependency Graph)

```
1. src/lib/git-utils.ts          ← NO dependencies (shared helper)
2. src/tools/curse-score.ts      ← depends on git-utils
3. src/tools/ownership.ts        ← depends on git-utils
4. src/tools/bus-factor.ts       ← depends on git-utils
5. src/tools/implicit-coupling.ts ← depends on git-utils
6. src/tools/blast-radius.ts     ← depends on coupling + ownership + git-utils
```

Tools 2-5 can be implemented in parallel. Only `blast_radius` depends on `implicit_coupling` and `ownership` being done first.

---

## Build & Test

### Build
```bash
cd ~/four-opencode-supertools
bun run build    # bun build entry --outdir dist --target bun --format esm --external @opencode-ai/plugin
```

### Run Tests
```bash
bun test                          # all tests
bun test --filter "curse_score"   # single tool
```

### Bump Version
After all 5 tools are implemented:
```json
"version": "0.3.0"
```

### Test Strategy
1. **Unit tests** — mock `runGit()` to return hardcoded git output strings. Test parsing, scoring, edge cases.
2. **Integration test** — run against `~/four-opencode-supertools` itself (it has git history).
3. **No live git repos in unit tests** — all git output must be mocked.

---

## Token Savings Estimates

| Tool | Manual approach (bash) | Plugin approach | Estimated savings |
|------|----------------------|-----------------|-------------------|
| curse_score | ~8 git commands, ~2000 tokens parsing | 1 call, ~200 tokens output | ~90% |
| bus_factor | ~5 commands, manual math | 1 call, computed | ~85% |
| implicit_coupling | Impractical (O(n²) pairs) | 1 call, computed | ~100% (impossible manually) |
| ownership | git blame + manual aggregation | 1 call, structured | ~80% |
| blast_radius | Manual cross-reference | 1 call, combined | ~95% |

---

## Reference

- **git-archaeologist npm:** https://www.npmjs.com/package/git-archaeologist (MIT)
- **Curse formula:** `changes × log₂(authors+1) × exp(-0.5 × age_years) × log₂(churn_rate+2) × acceleration`
- **Existing supertools pattern:** `src/tools/run-tests.ts` (best reference for shell execution + timeout handling)
- **Debug logging:** `src/lib/debug-logger.ts`, gated by `CC_DEBUG=true`
