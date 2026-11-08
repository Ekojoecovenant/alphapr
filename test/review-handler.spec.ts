import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/github/auth', () => ({
	createAppJWT: vi.fn(async () => 'app-jwt'),
	getInstallationToken: vi.fn(async () => 'installation-token'),
}));

vi.mock('../src/crypto', () => ({
	decryptSecret: vi.fn(async () => 'decrypted-api-key'),
}));

vi.mock('../src/db', () => ({
	getInstallation: vi.fn(),
	getReviewState: vi.fn(),
	saveReviewState: vi.fn(async () => undefined),
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

import { getInstallation, getReviewState, saveReviewState } from '../src/db';
import { completeCheckRun, editComment, getFailedCheckRuns } from '../src/github/api';
import { handlePREvent } from '../src/review-handler';
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

const mockedGetInstallation = vi.mocked(getInstallation);
const mockedGetReviewState = vi.mocked(getReviewState);
const mockedEditComment = vi.mocked(editComment);
const mockedCompleteCheckRun = vi.mocked(completeCheckRun);
const mockedGetFailedCheckRuns = vi.mocked(getFailedCheckRuns);
const mockedSaveReviewState = vi.mocked(saveReviewState);

beforeEach(() => {
	vi.clearAllMocks();
	mockedGetInstallation.mockResolvedValue({
		installation_id: 1,
		account_login: 'owner',
		api_key_encrypted: 'encrypted',
		model: 'deepseek/deepseek-v4-flash',
		severity_threshold: 'all',
		review_tone: 'thorough',
		ignore_paths: '',
		provider: 'openrouter',
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
