import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/review-handler', () => ({
	handlePREvent: vi.fn(async () => undefined),
	surfaceFailure: vi.fn(async () => undefined),
}));

import { PermanentError } from '../src/errors';
import { runFreeTierReview } from '../src/index';
import { handlePREvent, surfaceFailure } from '../src/review-handler';

const mockedHandlePREvent = vi.mocked(handlePREvent);
const mockedSurfaceFailure = vi.mocked(surfaceFailure);

const job = {
	installationId: 1,
	owner: 'owner',
	repo: 'repo',
	repoFullName: 'owner/repo',
	prNumber: 7,
	headSha: 'abc123def4567890',
	action: 'opened' as const,
	statusCommentId: 42,
	checkRunId: 99,
};

const env = { QUEUE_MODE: 'false' } as unknown as Env;

describe('runFreeTierReview', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		// Make the backoff instant: the delay is not what these tests are about.
		vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as unknown as typeof setTimeout);
	});

	it('does not retry a review that succeeds', async () => {
		await runFreeTierReview(job, env);

		expect(mockedHandlePREvent).toHaveBeenCalledOnce();
		expect(mockedSurfaceFailure).not.toHaveBeenCalled();
	});

	it('retries a transient failure once and succeeds on the second attempt', async () => {
		mockedHandlePREvent.mockRejectedValueOnce(new Error('429 rate limited')).mockResolvedValueOnce(undefined);

		await runFreeTierReview(job, env);

		expect(mockedHandlePREvent).toHaveBeenCalledTimes(2);
		// The PR is told a retry is coming rather than left on a stale "Reviewing…".
		expect(mockedSurfaceFailure).toHaveBeenCalledWith(job, env, false, true, 1, 2, '429 rate limited');
	});

	it('reports the terminal failure once the retry is used up', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('502 upstream'));

		await runFreeTierReview(job, env);

		expect(mockedHandlePREvent).toHaveBeenCalledTimes(2);
		expect(mockedSurfaceFailure).toHaveBeenLastCalledWith(job, env, false, false, 2, 2, '502 upstream');
	});

	it('does not retry a PermanentError', async () => {
		mockedHandlePREvent.mockRejectedValue(new PermanentError('auth error: 403 key limit exceeded'));

		await runFreeTierReview(job, env);

		expect(mockedHandlePREvent).toHaveBeenCalledOnce();
		expect(mockedSurfaceFailure).toHaveBeenCalledWith(job, env, true, false, 1, 2, 'auth error: 403 key limit exceeded');
	});

	it('does not retry when the first attempt already burned the time budget', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('provider timeout'));
		// startedAt, then the elapsed check after the failure.
		vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(25_000);

		await runFreeTierReview(job, env);

		expect(mockedHandlePREvent).toHaveBeenCalledOnce();
		expect(mockedSurfaceFailure).toHaveBeenCalledWith(job, env, false, false, 1, 2, 'provider timeout');
	});

	it('never throws, even when reporting the failure also fails', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('boom'));
		mockedSurfaceFailure.mockRejectedValue(new Error('github down'));

		await expect(runFreeTierReview(job, env)).resolves.toBeUndefined();
	});
});
