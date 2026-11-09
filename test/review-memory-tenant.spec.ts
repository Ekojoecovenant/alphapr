/**
 * Review memory is keyed by installation, not by repository name alone.
 *
 * The audit found `pr_reviews` keyed `(repo_full_name, pr_number)`, which meant
 * two tenants that both carried `acme/api` shared one row: one installation's
 * "last reviewed SHA" and last review body could be read by the other. These
 * tests pin the tenant into both the WHERE clause and the conflict target.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { getReviewState, saveReviewState } from '../src/db';

interface Call {
	sql: string;
	args: unknown[];
}

function recordingDb(row: unknown = null): { db: D1Database; calls: Call[] } {
	const calls: Call[] = [];
	const statement = (sql: string) => ({
		bind: (...args: unknown[]) => {
			calls.push({ sql, args });
			return {
				first: async () => row,
				run: async () => ({ meta: { changes: 1 } }),
			};
		},
	});
	const db = {
		prepare: (sql: string) => statement(sql),
	} as unknown as D1Database;
	return { db, calls };
}

describe('review memory is scoped to an installation', () => {
	it('reads one installation row, not a repository name that happens to match', async () => {
		const { db, calls } = recordingDb({ last_reviewed_sha: 'abc123', last_review_body: 'body' });

		const state = await getReviewState(db, 12, 'acme/api', 7);

		expect(state).toEqual({ last_reviewed_sha: 'abc123', last_review_body: 'body' });
		expect(calls[0].sql).toContain('WHERE installation_id = ? AND repo_full_name = ? AND pr_number = ?');
		expect(calls[0].args).toEqual([12, 'acme/api', 7]);
	});

	it('writes against the composite key so two tenants cannot overwrite each other', async () => {
		const { db, calls } = recordingDb();

		await saveReviewState(db, 12, 'acme/api', 7, 'sha1', 'review body', { inputTokens: 10, outputTokens: 2 });

		const [insert] = calls;
		expect(insert.sql).toContain('INSERT INTO pr_reviews (installation_id, repo_full_name, pr_number');
		expect(insert.sql).toContain('ON CONFLICT(installation_id, repo_full_name, pr_number)');
		expect(insert.args).toEqual([12, 'acme/api', 7, 'sha1', 'review body', 10, 2]);
	});

	it('returns null rather than an empty object when the tenant has no memory yet', async () => {
		const { db } = recordingDb(null);

		expect(await getReviewState(db, 99, 'acme/api', 7)).toBeNull();
	});
});
