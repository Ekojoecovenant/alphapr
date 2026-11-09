import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { deleteInstallation } from '../src/db';

/**
 * Uninstalling used to remove the `installations` row and leave the grants, the
 * per-repo overrides and the review memory behind. Nothing referenced them
 * again, but they outlived the installation they described — a stale grant can
 * re-appear the moment a webhook recreates the row under the same id.
 */
function recordingDb() {
	const writes: Array<{ sql: string; args: unknown[] }> = [];
	const db = {
		prepare: (sql: string) => ({
			bind: (...args: unknown[]) => {
				writes.push({ sql, args });
				return { run: async () => ({ meta: { changes: 1 } }) };
			},
		}),
	} as unknown as D1Database;
	return { db, writes };
}

describe('deleteInstallation', () => {
	it('removes the grants, the overrides and the memory, not just the row', async () => {
		const { db, writes } = recordingDb();

		await deleteInstallation(db, 149642729);

		const tables = writes.map((w) => w.sql.match(/DELETE FROM (\w+)/)?.[1]);
		expect(tables).toEqual(['user_installations', 'repos', 'pr_reviews', 'installations']);
		expect(writes.every((w) => w.args[0] === 149642729)).toBe(true);
	});
});
