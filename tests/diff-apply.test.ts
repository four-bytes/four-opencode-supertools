import { describe, it, expect } from 'bun:test';
import { parseUnifiedDiff } from '../src/lib/diff-parse';
import { applyHunks, summarizeChanges } from '../src/lib/diff-apply';

describe('applyHunks', () => {
  it('applies a simple replacement', () => {
    const original = 'line1\nline2\nline3\n';
    const patch = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 line1
-line2
+replaced
 line3`);

    const result = applyHunks(patch.hunks, original);
    expect(result).toBe('line1\nreplaced\nline3\n');
  });

  it('applies an addition', () => {
    const original = 'line1\nline2\n';
    const patch = parseUnifiedDiff(`@@ -1,2 +1,3 @@
 line1
+inserted
 line2`);

    const result = applyHunks(patch.hunks, original);
    expect(result).toBe('line1\ninserted\nline2\n');
  });

  it('applies a deletion', () => {
    const original = 'line1\nline2\nline3\n';
    const patch = parseUnifiedDiff(`@@ -1,3 +1,2 @@
 line1
-line2
 line3`);

    const result = applyHunks(patch.hunks, original);
    expect(result).toBe('line1\nline3\n');
  });

  it('applies multiple hunks', () => {
    const original = 'a\nb\nc\nd\ne\n';
    const patch = parseUnifiedDiff(`@@ -1,2 +1,2 @@
 a
-b
+bb
@@ -4,2 +4,2 @@
 d
-e
+ee`);

    const result = applyHunks(patch.hunks, original);
    expect(result).toBe('a\nbb\nc\nd\nee\n');
  });

  it('creates new file from @@ -0,0 diff', () => {
    const patch = parseUnifiedDiff(`@@ -0,0 +1,3 @@
+line1
+line2
+line3`);

    const result = applyHunks(patch.hunks, '');
    expect(result).toBe('line1\nline2\nline3\n');
  });
});

describe('summarizeChanges', () => {
  it('counts added and removed lines correctly', () => {
    const patch = parseUnifiedDiff(`@@ -1,5 +1,6 @@
 line1
-line2
-line3
+new2
+new3
+new4
 line4
 line5`);

    const summary = summarizeChanges(patch.hunks);
    expect(summary.added).toBe(3);
    expect(summary.removed).toBe(2);
  });
});
