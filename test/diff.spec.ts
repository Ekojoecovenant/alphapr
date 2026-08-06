import { describe, expect, it } from 'vitest';
import { parseDiff } from '../src/review/diff';

describe('parseDiff', () => {
	it('numbers added lines with their true new-file line numbers', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;`;

		const result = parseDiff(diff);

		expect(result.annotated).toContain('2: +const y = 2;');
		expect(result.validLines.get('foo.ts')?.has(2)).toBe(true);
	});

	it('does NOT anchor removed lines (they consume no new-file line number)', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,2 @@
 const x = 1;
-const y = 2;
 const z = 3;`;

		const result = parseDiff(diff);

		expect(result.annotated).toContain('-const y = 2;');
		expect(result.validLines.get('foo.ts')?.size).toBe(2);
		expect(result.validLines.get('foo.ts')?.has(1)).toBe(true);
		expect(result.validLines.get('foo.ts')?.has(2)).toBe(true);
	});

	it('skips ignored files entirely — no header, no content, no anchors', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
diff --git a/bar.ts b/bar.ts
index ghi..jkl 100644
--- a/bar.ts
+++ b/bar.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;`;

		const result = parseDiff(diff, ['foo.ts']);

		expect(result.validLines.has('foo.ts')).toBe(false);
		expect(result.annotated).not.toContain('foo.ts');
		expect(result.annotated).not.toContain('const y = 2');
		expect(result.validLines.get('bar.ts')?.has(2)).toBe(true);
		expect(result.annotated).toContain('bar.ts');
	});

	it('handles deleted files (+++ /dev/null) without crashing or anchoring', () => {
		const diff = `diff --git a/foo.ts b/foo.ts
deleted file mode 100644
index abc..000
--- a/foo.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const x = 1;
-const y = 2;`;

		expect(() => parseDiff(diff)).not.toThrow();

		const result = parseDiff(diff);
		expect(result.validLines.size).toBe(0);
	});

	it("does not number a trailing '\\ No newline at end of file' metadata line", () => {
		const diffWithMetadata = `diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,2 @@
 const x = 1;
+const y = 2;
\\ No newline at end of file`;

		const metaResult = parseDiff(diffWithMetadata);

		expect(metaResult.annotated).toContain('\\ No newline at end of file');
		expect(metaResult.annotated).not.toContain('3: \\');
		expect(metaResult.validLines.get('foo.ts')?.has(3)).toBe(false);
	});

	it('handles an empty diff without throwing', () => {
		const result = parseDiff('');
		expect(result.validLines.size).toBe(0);
		expect(result.annotated).toBe('');
	});
});
