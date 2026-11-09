import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '../src/auth';
import { handleDashboard } from '../src/dashboard';
import { listReviewHistory, loadUsageByModel, loadUsageTotals, recordReview } from '../src/db';
import { estimateCost, formatUsd, priceFor } from '../src/pricing';
import { type FakeDbSeed, makeFakeDb } from './helpers/fake-d1';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app.jwt'),
	getInstallationToken: vi.fn(async (_jwt: string, id: number) => `inst-token-${id}`),
}));

const ORIGIN = 'https://alphapr.test';
const SECRET = 'secret';
const FUTURE = new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

function makeEnv(db: D1Database): Env {
	return { DB: db, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'pem', SETUP_SIGNING_SECRET: SECRET } as unknown as Env;
}

function install(id: number, login: string) {
	return {
		installation_id: id,
		account_login: login,
		account_type: 'Organization',
		role: 'admin',
		provider: 'openrouter',
		model: 'deepseek/deepseek-v4-flash-0731',
		api_key_encrypted: 'iv.ciphertext',
		key_hint: '…abcd',
		last_error_code: null,
		last_error_message: null,
		last_error_at: null,
		last_review_at: null,
	};
}

const SESSION = { session_id: 'sid', last_used_at: null, expires_at: FUTURE, github_id: 4242, login: 'ekojoecovenant', avatar_url: null };

function seed(extra: Partial<FakeDbSeed> = {}): FakeDbSeed {
	return {
		sessions: [SESSION],
		installations: [install(12, 'acme'), install(13, 'other')],
		...extra,
	};
}

function stubEmptyRepos() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(JSON.stringify({ total_count: 0, repositories: [] }), { status: 200 })),
	);
}

function get(path: string) {
	return new Request(`${ORIGIN}${path}`, { headers: { Cookie: `${SESSION_COOKIE}=sid` } });
}

beforeEach(() => {
	stubEmptyRepos();
});

describe('recordReview', () => {
	it('writes one row per posted review, keeping unknown token counts as null', async () => {
		const fake = makeFakeDb({});
		await recordReview(fake.db, {
			installationId: 12,
			repoFullName: 'acme/api',
			prNumber: 7,
			headSha: 'abc1234',
			provider: 'openrouter',
			model: 'deepseek/deepseek-v4-flash-0731',
			usage: { inputTokens: 1200, outputTokens: 300 },
		});
		const write = fake.writes[0];
		expect(write?.sql).toContain('INSERT INTO review_history');
		expect(write?.args).toEqual([12, 'acme/api', 7, 'abc1234', 'openrouter', 'deepseek/deepseek-v4-flash-0731', 1200, 300]);
	});

	it('records nulls rather than zeros when the provider reported no usage', async () => {
		const fake = makeFakeDb({});
		await recordReview(fake.db, {
			installationId: 12,
			repoFullName: 'acme/api',
			prNumber: 7,
			headSha: 'abc1234',
			provider: null,
			model: null,
			usage: null,
		});
		expect(fake.writes[0]?.args.slice(6)).toEqual([null, null]);
	});
});

describe('reading history', () => {
	const rows = [
		{
			installation_id: 12,
			repo_full_name: 'acme/api',
			pr_number: 1,
			head_sha: 'aaa',
			created_at: '2026-11-09 10:00:00',
			model: 'gpt-4o-mini',
			input_tokens: 100,
			output_tokens: 10,
		},
		{
			installation_id: 12,
			repo_full_name: 'acme/api',
			pr_number: 2,
			head_sha: 'bbb',
			created_at: '2026-11-09 11:00:00',
			model: 'gpt-4o-mini',
			input_tokens: 200,
			output_tokens: 20,
		},
		{
			installation_id: 13,
			repo_full_name: 'other/web',
			pr_number: 3,
			head_sha: 'ccc',
			created_at: '2026-11-09 12:00:00',
			model: 'claude-sonnet-4',
			input_tokens: 400,
			output_tokens: 40,
		},
	];

	it('asks for nothing when the user administers nothing', async () => {
		const fake = makeFakeDb({ reviewHistory: rows });
		expect(await listReviewHistory(fake.db, [])).toEqual([]);
	});

	it('returns only the installations it was asked for, newest first, and honours the limit', async () => {
		const fake = makeFakeDb({ reviewHistory: rows });
		const all = await listReviewHistory(fake.db, [12]);
		expect(all.map((row) => row.pr_number)).toEqual([2, 1]);
		expect(all.some((row) => row.repo_full_name === 'other/web')).toBe(false);

		const limited = await listReviewHistory(fake.db, [12], 1);
		expect(limited).toHaveLength(1);
		expect(limited[0]?.pr_number).toBe(2);
	});

	it('totals usage across installations and treats missing token counts as zero', async () => {
		const fake = makeFakeDb({
			reviewHistory: [
				...rows,
				{
					installation_id: 12,
					repo_full_name: 'acme/api',
					pr_number: 9,
					head_sha: 'ddd',
					created_at: '2026-11-09 13:00:00',
					input_tokens: null,
					output_tokens: null,
				},
			],
		});
		expect(await loadUsageTotals(fake.db, [12])).toEqual({ reviews: 3, inputTokens: 300, outputTokens: 30 });
		expect(await loadUsageTotals(fake.db, [])).toEqual({ reviews: 0, inputTokens: 0, outputTokens: 0 });
	});

	it('groups usage by model so an unpriced model stays visible', async () => {
		const fake = makeFakeDb({
			reviewHistory: [
				...rows,
				{
					installation_id: 12,
					repo_full_name: 'acme/api',
					pr_number: 9,
					head_sha: 'ddd',
					created_at: '2026-11-09 13:00:00',
					model: null,
					input_tokens: 5,
					output_tokens: 1,
				},
			],
		});
		const grouped = await loadUsageByModel(fake.db, [12, 13]);
		const byModel = Object.fromEntries(grouped.map((row) => [row.model ?? 'unknown', row.reviews]));
		expect(byModel['gpt-4o-mini']).toBe(2);
		expect(byModel['claude-sonnet-4']).toBe(1);
		expect(byModel.unknown).toBe(1);
	});
});

describe('pricing', () => {
	it('matches the longest model prefix, so gpt-4o-mini is not priced as gpt-4o', () => {
		expect(priceFor('gpt-4o-mini')?.inputPerMillion).toBe(0.15);
		expect(priceFor('gpt-4o')?.inputPerMillion).toBe(2.5);
		expect(priceFor('openai/gpt-4o-mini-2024-07-18')?.inputPerMillion).toBe(0.15);
	});

	it('refuses to price a model it does not know', () => {
		expect(priceFor('deepseek/deepseek-v4-flash-0731')).toBeNull();
		expect(estimateCost('deepseek/deepseek-v4-flash-0731', 1000, 1000)).toBeNull();
	});

	it('estimates input plus output at per-million rates', () => {
		// 100k input at $0.15/M = $0.015, 20k output at $0.60/M = $0.012.
		expect(estimateCost('gpt-4o-mini', 100_000, 20_000)).toBeCloseTo(0.027, 6);
	});

	it('formats small amounts without pretending they are zero', () => {
		expect(formatUsd(null)).toBeNull();
		expect(formatUsd(0)).toBe('$0');
		expect(formatUsd(0.00004)).toBe('< $0.0001');
		expect(formatUsd(0.027)).toBe('$0.0270');
		expect(formatUsd(12.3456)).toBe('$12.35');
	});
});

describe('GET /dashboard/reviews', () => {
	it('lists the reviews the signed-in admin can see, with links and tokens', async () => {
		const fake = makeFakeDb(
			seed({
				reviewHistory: [
					{
						installation_id: 12,
						repo_full_name: 'acme/api',
						pr_number: 42,
						head_sha: 'abcdef1234567',
						created_at: '2026-11-09 16:04:11',
						model: 'gpt-4o-mini',
						provider: 'openai',
						input_tokens: 12431,
						output_tokens: 802,
					},
					{
						installation_id: 13,
						repo_full_name: 'other/web',
						pr_number: 3,
						head_sha: '1234567890abc',
						created_at: '2026-11-09 15:00:00',
						model: 'claude-sonnet-4',
						provider: 'anthropic',
						input_tokens: 500,
						output_tokens: 60,
					},
				],
			}),
		);
		const res = await handleDashboard(get('/dashboard/reviews'), makeEnv(fake.db));
		const html = await res?.text();
		expect(res?.status).toBe(200);
		expect(html).toContain('https://github.com/acme/api/pull/42');
		expect(html).toContain('12,431 in / 802 out');
		expect(html).toContain('2026-11-09 16:04 UTC');
		expect(html).toContain('abcdef1');
		expect(html).toContain('Reviews');
	});

	it('sends a signed-out visitor to the sign-in page instead of an empty table', async () => {
		const fake = makeFakeDb({ reviewHistory: [] });
		const res = await handleDashboard(new Request(`${ORIGIN}/dashboard/reviews`), makeEnv(fake.db));
		expect(await res?.text()).toContain('Sign in with GitHub');
	});

	it('is read-only', async () => {
		const fake = makeFakeDb(seed());
		const res = await handleDashboard(new Request(`${ORIGIN}/dashboard/reviews`, { method: 'POST' }), makeEnv(fake.db));
		expect(res?.status).toBe(405);
		expect(res?.headers.get('Allow')).toBe('GET');
	});
});

describe('GET /dashboard/usage', () => {
	it('shows totals, a per-model estimate, and says which models it cannot price', async () => {
		const fake = makeFakeDb(
			seed({
				reviewHistory: [
					{
						installation_id: 12,
						repo_full_name: 'acme/api',
						pr_number: 1,
						head_sha: 'aaa',
						created_at: '2026-11-09 10:00:00',
						model: 'gpt-4o-mini',
						provider: 'openai',
						input_tokens: 100_000,
						output_tokens: 20_000,
					},
					{
						installation_id: 12,
						repo_full_name: 'acme/api',
						pr_number: 2,
						head_sha: 'bbb',
						created_at: '2026-11-09 11:00:00',
						model: 'deepseek/deepseek-v4-flash-0731',
						provider: 'openrouter',
						input_tokens: 900_000,
						output_tokens: 40_000,
					},
				],
			}),
		);
		const res = await handleDashboard(get('/dashboard/usage'), makeEnv(fake.db));
		const html = await res?.text();
		expect(res?.status).toBe(200);
		expect(html).toContain('$0.0270');
		expect(html).toContain('not priced');
		expect(html).toContain('AlphaPR does not guess a price it does not know');
		expect(html).toContain('1,000,000');
		// Only the priced model contributes to the headline number.
		expect(html).toContain('estimated cost');
	});

	it('shows a dash rather than $0 when nothing can be priced', async () => {
		const fake = makeFakeDb(
			seed({
				reviewHistory: [
					{
						installation_id: 12,
						repo_full_name: 'acme/api',
						pr_number: 1,
						head_sha: 'aaa',
						created_at: '2026-11-09 10:00:00',
						model: 'deepseek/deepseek-v4-flash-0731',
						input_tokens: 100,
						output_tokens: 10,
					},
				],
			}),
		);
		const html = await (await handleDashboard(get('/dashboard/usage'), makeEnv(fake.db)))?.text();
		expect(html).toContain('not priced');
		// The headline says "—" rather than "$0": the work happened, the price is unknown.
		expect(html).toContain('—');
		expect(html).not.toContain('$0.0001');
	});
});
