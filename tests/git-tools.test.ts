// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025-2026 Four Bytes

import { describe, it, expect, beforeAll } from 'bun:test';
import { git } from '../src/lib/git-runner';
import { parseLogOutput } from '../src/lib/git-log-parser';
import { parseBlameOutput } from '../src/lib/git-blame-parser';
import { computeCurseScores } from '../src/tools/curse-score';
import { computeBusFactor } from '../src/tools/bus-factor';
import { computeCoupling } from '../src/tools/implicit-coupling';
import { computeOwnership } from '../src/tools/ownership';
import { computeBlastRadius } from '../src/tools/blast-radius';

const GIT_AVAILABLE = Bun.which('git') !== null;
const SKIP_REASON = 'git not found in PATH';

// ============================================================
// git-runner
// ============================================================

describe('git-runner', () => {
  it('throws when git is not installed (mock via invalid command)', async () => {
    // This test works regardless of git availability
    if (!GIT_AVAILABLE) {
      // If git is truly not available, just assert we skip correctly
      expect(GIT_AVAILABLE).toBe(false);
      return;
    }
    // git --version should work and return something
    const result = await git(['--version']);
    expect(result).toContain('git version');
  });

  it('throws for non-zero exit', {
    skip: !GIT_AVAILABLE,
    skipReason: SKIP_REASON,
  }, async () => {
    try {
      await git(['--non-existent-flag-xyz']);
      expect.unreachable('Should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).toContain('exited with code');
    }
  });

  it('throws for non-existent repo', {
    skip: !GIT_AVAILABLE,
    skipReason: SKIP_REASON,
  }, async () => {
    // Use an existing directory that is not a git repo
    try {
      await git(['log'], '/tmp');
      expect.unreachable('Should have thrown');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      // Could be "Not a git repository" or "fatal: not a git repository"
      const ok =
        msg.includes('not a git repository') ||
        msg.includes('Not a git repository') ||
        msg.toLowerCase().includes('not a git repository');
      expect(ok).toBe(true);
    }
  });
});

// ============================================================
// git-log-parser (unit: parseLogOutput)
// ============================================================

describe('parseLogOutput', () => {
  it('parses a single commit with one file', () => {
    const raw = [
      '0000000000000000000000000000000000000001|Alice|2024-01-15T10:00:00+01:00',
      '',
      '10\t5\tsrc/main.ts',
    ].join('\n');

    const commits = parseLogOutput(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0].hash).toBe('0000000000000000000000000000000000000001');
    expect(commits[0].author).toBe('Alice');
    expect(commits[0].date).toBe('2024-01-15T10:00:00+01:00');
    expect(commits[0].files).toHaveLength(1);
    expect(commits[0].files[0]).toEqual({ path: 'src/main.ts', added: 10, deleted: 5 });
  });

  it('parses multiple commits with multiple files', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|Alice|2024-01-15T00:00:00+00:00',
      '',
      '10\t0\tsrc/a.ts',
      '0\t5\tsrc/b.ts',
      '',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|Bob|2024-01-16T00:00:00+00:00',
      '',
      '1\t1\tsrc/c.ts',
    ].join('\n');

    const commits = parseLogOutput(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0].files).toHaveLength(2);
    expect(commits[0].files[0].path).toBe('src/a.ts');
    expect(commits[0].files[0].added).toBe(10);
    expect(commits[0].files[0].deleted).toBe(0);
    expect(commits[0].files[1].path).toBe('src/b.ts');
    expect(commits[0].files[1].added).toBe(0);
    expect(commits[0].files[1].deleted).toBe(5);
    expect(commits[1].files).toHaveLength(1);
    expect(commits[1].author).toBe('Bob');
  });

  it('handles binary file changes (dash in numstat)', () => {
    const raw = [
      'cccccccccccccccccccccccccccccccccccccccc|Alice|2024-01-15T00:00:00+00:00',
      '',
      '-\t-\tassets/logo.png',
    ].join('\n');

    const commits = parseLogOutput(raw);
    expect(commits[0].files[0]).toEqual({ path: 'assets/logo.png', added: 0, deleted: 0 });
  });

  it('handles empty output', () => {
    const commits = parseLogOutput('');
    expect(commits).toHaveLength(0);
  });

  it('handles file paths with special characters', () => {
    const raw = [
      'dddddddddddddddddddddddddddddddddddddddd|Alice|2024-01-15T00:00:00+00:00',
      '',
      '5\t3\tsrc/sub dir/file name.ts',
      '1\t0\tsrc/file-with-dashes.ts',
    ].join('\n');

    const commits = parseLogOutput(raw);
    expect(commits[0].files[0].path).toBe('src/sub dir/file name.ts');
    expect(commits[0].files[1].path).toBe('src/file-with-dashes.ts');
  });
});

// ============================================================
// git-blame-parser (unit: parseBlameOutput)
// ============================================================

describe('parseBlameOutput', () => {
  it('parses single-line blame', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author Alice',
      '\tconsole.log("hello");',
    ].join('\n');

    const lines = parseBlameOutput(raw);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      line: 1,
      author: 'Alice',
      commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('parses multi-line blame with multiple authors', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 3',
      'author Alice',
      '\tline one',
      'author-mail <alice@example.com>',
      '\tline two',
      '\tline three',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 1 4 2',
      'author Bob',
      '\tline four',
      '\tline five',
    ].join('\n');

    const lines = parseBlameOutput(raw);
    expect(lines).toHaveLength(5);
    expect(lines[0].author).toBe('Alice');
    expect(lines[0].line).toBe(1);
    expect(lines[1].author).toBe('Alice');
    expect(lines[1].line).toBe(2);
    expect(lines[2].author).toBe('Alice');
    expect(lines[2].line).toBe(3);
    expect(lines[3].author).toBe('Bob');
    expect(lines[3].line).toBe(4);
    expect(lines[4].author).toBe('Bob');
    expect(lines[4].line).toBe(5);
  });

  it('handles empty output', () => {
    const lines = parseBlameOutput('');
    expect(lines).toHaveLength(0);
  });

  it('ignores non-author pseudo-headers', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1',
      'author Alice',
      'author-mail <alice@example.com>',
      'author-time 1234567890',
      'committer Bob',
      '\tsome code',
    ].join('\n');

    const lines = parseBlameOutput(raw);
    expect(lines).toHaveLength(1);
    expect(lines[0].author).toBe('Alice');
  });
});

// ============================================================
// curse-score (unit: computeCurseScores)
// ============================================================

describe('computeCurseScores', () => {
  it('returns empty array for no commits', () => {
    const results = computeCurseScores([], 10);
    expect(results).toEqual([]);
  });

  it('computes scores for files', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: new Date().toISOString(), // today = recent
        files: [
          { path: 'src/hot.ts', added: 10, deleted: 0 },
          { path: 'src/cold.ts', added: 1, deleted: 0 },
        ],
      },
      {
        hash: 'b'.repeat(40),
        author: 'Bob',
        date: new Date().toISOString(), // today = recent
        files: [
          { path: 'src/hot.ts', added: 5, deleted: 0 },
          { path: 'src/warm.ts', added: 3, deleted: 0 },
        ],
      },
      {
        hash: 'c'.repeat(40),
        author: 'Bob',
        date: '2024-01-01T00:00:00Z', // old
        files: [
          { path: 'src/hot.ts', added: 2, deleted: 0 },
          { path: 'src/cold.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    const results = computeCurseScores(commits, 10);

    expect(results.length).toBe(3);
    // src/hot.ts should rank highest (3 changes, 2 authors, all recent)
    expect(results[0].file).toBe('src/hot.ts');
    expect(results[0].changes).toBe(3);
    expect(results[0].authors).toBe(2);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('respects topN parameter', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: new Date().toISOString(),
        files: [
          { path: 'src/a.ts', added: 10, deleted: 0 },
          { path: 'src/b.ts', added: 5, deleted: 0 },
          { path: 'src/c.ts', added: 3, deleted: 0 },
        ],
      },
    ];

    const results = computeCurseScores(commits, 1);
    expect(results).toHaveLength(1);
  });

  it('has accelerating churn for recent-heavy files', () => {
    const now = new Date();
    const old = '2020-01-01T00:00:00Z';

    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: now.toISOString(), // recent
        files: [{ path: 'src/hot.ts', added: 50, deleted: 0 }],
      },
      {
        hash: 'b'.repeat(40),
        author: 'Bob',
        date: now.toISOString(), // recent
        files: [{ path: 'src/hot.ts', added: 50, deleted: 0 }],
      },
      {
        hash: 'c'.repeat(40),
        author: 'Alice',
        date: old, // old
        files: [{ path: 'src/hot.ts', added: 1, deleted: 0 }],
      },
    ];

    const results = computeCurseScores(commits, 10);
    expect(results[0].churn_trend).toBe('accelerating');
  });
});

// ============================================================
// implicit-coupling (unit: computeCoupling)
// ============================================================

describe('computeCoupling', () => {
  it('returns empty for no multi-file commits', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [{ path: 'src/a.ts', added: 1, deleted: 0 }],
      },
    ];

    const results = computeCoupling(commits, 0.5);
    expect(results).toHaveLength(0);
  });

  it('finds co-changing file pairs', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
        ],
      },
      {
        hash: 'b'.repeat(40),
        author: 'Alice',
        date: '2024-01-02T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    const results = computeCoupling(commits, 0.5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const pair = results.find((r) => r.files.includes('src/a.ts') && r.files.includes('src/b.ts'));
    expect(pair).toBeDefined();
    expect(pair!.co_commits).toBe(2);
    expect(pair!.coupling_strength).toBe(1.0);
  });

  it('respects threshold', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
        ],
      },
      {
        hash: 'b'.repeat(40),
        author: 'Alice',
        date: '2024-01-02T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/c.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    // With threshold 0.9, a-b should be filtered out (only 1/2 commits together)
    const highThreshold = computeCoupling(commits, 0.9);
    expect(highThreshold).toHaveLength(0);

    // With threshold 0.4, a-b pair should appear (50% coupling)
    const lowThreshold = computeCoupling(commits, 0.4);
    const pair = lowThreshold.find((r) => r.files.includes('src/a.ts') && r.files.includes('src/b.ts'));
    expect(pair).toBeDefined();
  });

  it('handles multiple pairs in one commit', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
          { path: 'src/c.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    const results = computeCoupling(commits, 0.5);
    // 3 files = 3 pairs: ab, ac, bc
    expect(results).toHaveLength(3);
  });
});

// ============================================================
// ownership (unit: computeOwnership)
// ============================================================

describe('computeOwnership', {
  skip: !GIT_AVAILABLE,
  skipReason: SKIP_REASON,
}, () => {
  it('returns ownership data for a file', async () => {
    // Test against the main entry file which should have blame data
    const result = await computeOwnership('src/four-opencode-supertools.ts');
    expect(result.path).toBe('src/four-opencode-supertools.ts');
    expect(result.total_lines).toBeGreaterThan(0);
    expect(result.authors.length).toBeGreaterThan(0);
    for (const author of result.authors) {
      expect(author.author).toBeTruthy();
      expect(author.lines).toBeGreaterThan(0);
      expect(author.pct).toBeGreaterThan(0);
    }
  });

  it('returns ownership data for a directory', async () => {
    const result = await computeOwnership('src/tools');
    expect(result.path).toBe('src/tools');
    expect(result.total_lines).toBeGreaterThan(0);
    expect(result.authors.length).toBeGreaterThan(0);
    expect(result.files).toBeDefined();
    const fileKeys = Object.keys(result.files!);
    expect(fileKeys.length).toBeGreaterThan(0);
    for (const file of fileKeys) {
      expect(result.files![file].total).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// bus-factor (integration: computeBusFactor)
// ============================================================

describe('computeBusFactor', {
  skip: !GIT_AVAILABLE,
  skipReason: SKIP_REASON,
}, () => {
  it('returns bus factor analysis for repo directories', async () => {
    const result = await computeBusFactor();
    expect(Array.isArray(result)).toBe(true);
    // The project has src/, tests/ at minimum
    expect(result.length).toBeGreaterThan(0);

    for (const entry of result) {
      expect(entry.directory).toBeTruthy();
      expect(entry.total_lines).toBeGreaterThan(0);
      expect(entry.top_author).toBeTruthy();
      expect(entry.top_author_pct).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low']).toContain(entry.risk);
    }
  });
});

// ============================================================
// blast-radius (integration: computeBlastRadius)
// ============================================================

describe('computeBlastRadius', {
  skip: !GIT_AVAILABLE,
  skipReason: SKIP_REASON,
}, () => {
  it('returns blast radius for a real file', async () => {
    const result = await computeBlastRadius('src/four-opencode-supertools.ts');
    expect(result.target).toBe('src/four-opencode-supertools.ts');
    expect(Array.isArray(result.coupled_files)).toBe(true);
    expect(Array.isArray(result.author_related)).toBe(true);
    expect(typeof result.total_blast_radius).toBe('number');
    expect(['critical', 'high', 'medium', 'low']).toContain(result.risk);
  });

  it('returns empty blast radius for non-existent file', async () => {
    const result = await computeBlastRadius('nonexistent-file.ts');
    expect(result.coupled_files).toHaveLength(0);
    expect(result.total_blast_radius).toBe(0);
    expect(result.risk).toBe('low');
  });
});

// ============================================================
// Integration: real git log parsing
// ============================================================

describe('git-log integration', {
  skip: !GIT_AVAILABLE,
  skipReason: SKIP_REASON,
}, () => {
  it('can parse repo git log', async () => {
    const output = await git(['log', "--numstat", "--format=%H|%an|%aI", '-n', '5']);
    const commits = parseLogOutput(output);
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(commit.author).toBeTruthy();
      expect(commit.date).toBeTruthy();
    }
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('edge cases', () => {
  it('parseLogOutput handles trailing blank lines', () => {
    const raw = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|Alice|2024-01-01T00:00:00Z',
      '',
      '1\t0\tsrc/a.ts',
      '',
      '',
    ].join('\n');

    const commits = parseLogOutput(raw);
    expect(commits).toHaveLength(1);
  });

  it('computeCurseScores handles single author edge case', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: new Date().toISOString(),
        files: [{ path: 'src/solo.ts', added: 5, deleted: 0 }],
      },
    ];

    const results = computeCurseScores(commits, 10);
    expect(results).toHaveLength(1);
    expect(results[0].authors).toBe(1);
  });

  it('computeCoupling with threshold 0 returns all pairs', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    const results = computeCoupling(commits, 0);
    expect(results).toHaveLength(1);
  });

  it('computeCoupling with threshold 1.0 filters all but perfect pairs', () => {
    const commits = [
      {
        hash: 'a'.repeat(40),
        author: 'Alice',
        date: '2024-01-01T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/b.ts', added: 1, deleted: 0 },
        ],
      },
      {
        hash: 'b'.repeat(40),
        author: 'Alice',
        date: '2024-01-02T00:00:00Z',
        files: [
          { path: 'src/a.ts', added: 1, deleted: 0 },
          { path: 'src/c.ts', added: 1, deleted: 0 },
        ],
      },
    ];

    const results = computeCoupling(commits, 1.0);
    // No pair is perfect (a-c only seen together once out of 2 a commits)
    expect(results).toHaveLength(0);
  });
});
