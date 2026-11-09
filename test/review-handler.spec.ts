import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app-jwt'),
	getInstallationToken: vi.fn(async () => 'installation-token'),
}));

vi.mock('../src/crypto', () => ({
	decryptSecret: vi.fn(async () => 'decrypted-api-key'),
}));

vi.mock('../src/db', () => ({
	getReviewState: vi.fn(),
	saveReviewState: vi.fn(async () => undefined),
	recordReview: vi.fn(async () => undefined),
}));

vi.mock('../src/review-config', () => ({
	loadRepoConfig: vi.fn(),
}));

vi.mock('../src/github/api', () => ({
	postReviewComment: vi.fn(async () => 1),
	editComment: vi.fn(async () => undefined),
	createReview: vi.fn(async () => undefined),
	completeCheckRun: vi.fn(async () => undefined),
	getPRDescription: vi.fn(async () => ''),
	updatePRDescription: vi.fn(async () => undefined),
	getFailedCheckRuns: vi.fn(async () => []),
	markCheckRunRetrying: vi.fn(async () => undefined),
}));

import { getReviewState, recordReview, saveReviewState } from '../src/db';
import { completeCheckRun, editComment, getFailedCheckRuns } from '../src/github/api';
import { loadRepoConfig } from '../src/review-config';
import { handlePREvent, sanitizeDetail, surfaceFailure } from '../src/review-handler';
import type { ReviewJob } from '../src/types';

const HEAD_SHA = 'abc123def4567890';

function makeJob(overrides: Partial<ReviewJob> = {}): ReviewJob {
	return {
		installationId: 1,
		owner: 'owner',
		repo: 'repo',
		repoFullName: 'owner/repo',
		prNumber: 7,
		headSha: HEAD_SHA,
		action: 'synchronize',
		statusCommentId: 42,
		checkRunId: 99,
		...overrides,
	};
}

const env = {
	GITHUB_APP_ID: '1',
	GITHUB_APP_PRIVATE_KEY: 'private-key',
	KEY_ENCRYPTION_SECRET: 'encryption-secret',
	QUEUE_MODE: 'true',
	DB: {},
} as unknown as Env;

const mockedLoadRepoConfig = vi.mocked(loadRepoConfig);
const mockedGetReviewState = vi.mocked(getReviewState);
const mockedEditComment = vi.mocked(editComment);
const mockedCompleteCheckRun = vi.mocked(completeCheckRun);
const mockedGetFailedCheckRuns = vi.mocked(getFailedCheckRuns);
const mockedSaveReviewState = vi.mocked(saveReviewState);
const mockedRecordReview = vi.mocked(recordReview);

beforeEach(() => {
	vi.clearAllMocks();
	mockedLoadRepoConfig.mockResolvedValue({
		accountLogin: 'owner',
		apiKeyEncrypted: 'encrypted',
		enabled: true,
		provider: 'openrouter',
		model: 'deepseek/deepseek-v4-flash',
		severityThreshold: 'all',
		reviewTone: 'thorough',
		ignorePaths: [],
		ignorePathsRaw: '',
		inherits: {
			provider: true,
			model: true,
			severityThreshold: true,
			reviewTone: true,
			ignorePaths: true,
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('handlePREvent — duplicate commit guard', () => {
	it('does not re-review a commit that was already reviewed', async () => {
		mockedGetReviewState.mockResolvedValue({ last_reviewed_sha: HEAD_SHA, last_review_body: 'previous review' });

		await handlePREvent(makeJob(), env);

		// The expensive work must not happen: no diff/check-run fetch, no LLM call,
		// no state rewrite.
		expect(mockedGetFailedCheckRuns).not.toHaveBeenCalled();
		expect(mockedSaveReviewState).not.toHaveBeenCalled();
	});

	it('still resolves the status comment, so the PR never shows "Reviewing…" forever', async () => {
		mockedGetReviewState.mockResolvedValue({ last_reviewed_sha: HEAD_SHA, last_review_body: null });

		await handlePREvent(makeJob(), env);

		expect(mockedEditComment).toHaveBeenCalledTimes(1);
		expect(mockedEditComment).toHaveBeenCalledWith('installation-token', 'owner', 'repo', 42, expect.stringContaining('Already reviewed'));
	});

	it('still concludes the check run as a success', async () => {
		mockedGetReviewState.mockResolvedValue({ last_reviewed_sha: HEAD_SHA, last_review_body: null });

		await handlePREvent(makeJob(), env);

		expect(mockedCompleteCheckRun).toHaveBeenCalledWith(
			'installation-token',
			'owner',
			'repo',
			99,
			'success',
			'Already reviewed',
			expect.any(String),
		);
	});

	it('survives a status comment that has been deleted', async () => {
		mockedGetReviewState.mockResolvedValue({ last_reviewed_sha: HEAD_SHA, last_review_body: null });
		mockedEditComment.mockRejectedValueOnce(new Error('404 Gone'));

		// A missing comment must not stop the check run from concluding.
		await expect(handlePREvent(makeJob(), env)).resolves.toBeUndefined();
		expect(mockedCompleteCheckRun).toHaveBeenCalled();
	});

	it('reviews normally when the commit differs from the last reviewed one', async () => {
		mockedGetReviewState.mockResolvedValue({ last_reviewed_sha: 'an-older-sha', last_review_body: null });
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 })),
		);

		// It proceeds past the guard and fails later, on the real diff fetch (the
		// incremental compare path, since a prior review exists) — which is
		// exactly what "not skipped" looks like from here.
		await expect(handlePREvent(makeJob(), env)).rejects.toThrow(/Failed to fetch (full|compare) diff/);
		expect(mockedEditComment).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.stringContaining('Already reviewed'),
		);
	});

	it('reviews normally for a PR that has never been reviewed', async () => {
		mockedGetReviewState.mockResolvedValue(null);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 })),
		);

		await expect(handlePREvent(makeJob(), env)).rejects.toThrow(/Failed to fetch (full|compare) diff/);
	});
});

describe('handlePREvent — token usage', () => {
	const DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
`;

	/** Serve the diff for GitHub's pull request URL and a review for the LLM call. */
	function stubHappyPath(usage: { prompt_tokens: number; completion_tokens: number } | undefined) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = String(input);
				if (url.includes('openrouter.ai')) {
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: { content: '{"verdict":"✅ LGTM — no issues found.","findings":[]}' },
									finish_reason: 'stop',
								},
							],
							...(usage ? { usage } : {}),
						}),
						{ status: 200 },
					);
				}
				if (url.includes('/pulls/')) return new Response(DIFF, { status: 200 });
				return new Response('{}', { status: 200 });
			}),
		);
	}

	it('persists the review call usage alongside the review state', async () => {
		mockedGetReviewState.mockResolvedValue(null);
		stubHappyPath({ prompt_tokens: 9000, completion_tokens: 3000 });

		await handlePREvent(makeJob({ action: 'opened' }), { ...env, QUEUE_MODE: 'false' } as Env);

		expect(mockedSaveReviewState).toHaveBeenCalledWith(expect.anything(), 1, 'owner/repo', 7, HEAD_SHA, expect.any(String), {
			inputTokens: 9000,
			outputTokens: 3000,
		});
	});

	it('records the review in the history, separate from the per-PR memory', async () => {
		mockedGetReviewState.mockResolvedValue(null);
		stubHappyPath({ prompt_tokens: 9000, completion_tokens: 3000 });

		await handlePREvent(makeJob({ action: 'opened' }), { ...env, QUEUE_MODE: 'false' } as Env);

		expect(mockedRecordReview).toHaveBeenCalledTimes(1);
		expect(mockedRecordReview).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				installationId: 1,
				repoFullName: 'owner/repo',
				prNumber: 7,
				headSha: HEAD_SHA,
				usage: { inputTokens: 9000, outputTokens: 3000 },
			}),
		);
	});

	it('reports the token count in the check run summary', async () => {
		mockedGetReviewState.mockResolvedValue(null);
		stubHappyPath({ prompt_tokens: 9000, completion_tokens: 3000 });

		await handlePREvent(makeJob({ action: 'opened' }), { ...env, QUEUE_MODE: 'false' } as Env);

		expect(mockedCompleteCheckRun).toHaveBeenCalledWith(
			'installation-token',
			'owner',
			'repo',
			99,
			'success',
			expect.any(String),
			expect.stringContaining('12,000 tokens'),
		);
	});

	it('omits the token count rather than claiming zero when the provider reports none', async () => {
		mockedGetReviewState.mockResolvedValue(null);
		stubHappyPath(undefined);

		await handlePREvent(makeJob({ action: 'opened' }), { ...env, QUEUE_MODE: 'false' } as Env);

		const summary = mockedCompleteCheckRun.mock.calls[0][6];
		expect(summary).not.toContain('tokens');
		expect(mockedSaveReviewState).toHaveBeenCalledWith(expect.anything(), 1, 'owner/repo', 7, HEAD_SHA, expect.any(String), null);
	});
});

describe('sanitizeDetail', () => {
	it('collapses multi-line provider bodies into one quotable line', () => {
		expect(sanitizeDetail('  rate\n\tlimited  ')).toBe('rate limited');
	});

	it('redacts credentials that a provider might echo back', () => {
		const out = sanitizeDetail('bad key sk-or-v1-0123456789abcdef failed; sent Bearer abc.def-123');
		expect(out).not.toContain('sk-or-v1-0123456789abcdef');
		expect(out).not.toContain('abc.def-123');
		expect(out).toContain('[redacted]');
	});

	it('strips angle brackets so the comment cannot gain raw HTML', () => {
		expect(sanitizeDetail('<img src=x>see <b>this</b>')).toBe('img src=xsee bthis/b');
	});

	it('truncates long details with an ellipsis', () => {
		const out = sanitizeDetail('x'.repeat(500));
		expect(out).toHaveLength(301);
		expect(out.endsWith('…')).toBe(true);
	});
});

describe('surfaceFailure', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('quotes the provider reason on a permanent failure', async () => {
		await surfaceFailure(makeJob(), env, true, false, 1, 3, 'openrouter auth error: 403 Key limit exceeded');

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain("This won't be retried");
		expect(text).toContain('> openrouter auth error: 403 Key limit exceeded');
	});

	it('surfaces the real OpenRouter key-limit body instead of a generic hint', async () => {
		const body =
			'openrouter auth error: 403 {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/a6b5f67a $0.80 of $0.80 used; does not reset.","code":403}}';

		await surfaceFailure(makeJob(), env, true, false, 1, 3, body);

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain('Key limit exceeded');
		expect(text).toContain('$0.80 of $0.80 used');
	});

	it('keeps the configuration hint when no detail is available', async () => {
		await surfaceFailure(makeJob(), env, true, false, 1, 3);

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain("check your installation's configuration");
		expect(text).not.toContain('>');
	});

	it('places the attempt counter outside the quote, so it is not read as provider text', async () => {
		await surfaceFailure(makeJob(), env, true, false, 1, 3, 'openrouter auth error: 403 Key limit exceeded');

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain('configuration. (attempt 1/3)\n\n> openrouter auth error');
		expect(text).not.toContain('Key limit exceeded (attempt 1/3)');
	});

	it('does not quote a detail while a retry is still pending', async () => {
		await surfaceFailure(makeJob(), env, false, true, 1, 3, 'temporary blip');

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain('Retrying automatically');
		expect(text).not.toContain('temporary blip');
	});

	it('quotes the detail once retries are exhausted', async () => {
		await surfaceFailure(makeJob(), env, false, false, 3, 3, 'temporary blip');

		const [, , , , text] = mockedEditComment.mock.calls[0];
		expect(text).toContain('All retry attempts exhausted');
		expect(text).toContain('> temporary blip');
	});

	it('never throws when the status comment cannot be edited', async () => {
		mockedEditComment.mockRejectedValueOnce(new Error('403 forbidden'));

		await expect(surfaceFailure(makeJob(), env, true, false, 1, 3, 'boom')).resolves.toBeUndefined();
		expect(mockedCompleteCheckRun).toHaveBeenCalled();
	});
});
