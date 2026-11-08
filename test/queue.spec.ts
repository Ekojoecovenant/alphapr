// @ts-check

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/review-handler', async () => {
	const actual = await vi.importActual<typeof import('../src/review-handler')>('../src/review-handler');
	return {
		...actual,
		handlePREvent: vi.fn(),
		surfaceFailure: vi.fn().mockResolvedValue(undefined),
	};
});

import { PermanentError } from '../src/errors';
import worker from '../src/index';
import { handlePREvent, type ReviewJob, surfaceFailure } from '../src/review-handler';

// Mocked queue message shape — matches the subset of Cloudflare's Message<T>
// interface that the queue() handler actually uses.
interface MockMessage {
	body: ReviewJob;
	attempts: number;
	ack: ReturnType<typeof vi.fn>;
	retry: ReturnType<typeof vi.fn>;
}

function makeMessage(overrides: Partial<ReviewJob> = {}, attempts = 1): MockMessage {
	return {
		body: {
			installationId: 1,
			owner: 'test-owner',
			repo: 'test-repo',
			repoFullName: 'test-owner/test-repo',
			prNumber: 1,
			headSha: 'abc123',
			action: 'opened',
			statusCommentId: 42,
			checkRunId: 99,
			...overrides,
		},
		attempts,
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

function makeBatch(messages: MockMessage[], queue = 'pr-review-jobs'): MessageBatch<ReviewJob> {
	return {
		messages: messages as unknown as MessageBatch<ReviewJob>['messages'],
		queue,
	} as MessageBatch<ReviewJob>;
}

const mockedHandlePREvent = vi.mocked(handlePREvent);

describe('queue consumer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('acks the message when handlePREvent succeeds', async () => {
		mockedHandlePREvent.mockResolvedValue(undefined);
		const message = makeMessage();
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('retries a transient failure (plain Error)', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('temporary network blip'));
		const message = makeMessage();
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(message.retry).toHaveBeenCalledOnce();
		expect(message.ack).not.toHaveBeenCalled();
	});

	it('acks (does NOT retry) a PermanentError', async () => {
		mockedHandlePREvent.mockRejectedValue(new PermanentError('bad api key, never retry'));
		const message = makeMessage();
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('calls surfaceFailure with willRetry=true for a transient error', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('temporary'));
		const message = makeMessage();
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, false, true, 1, 3, 'temporary');
	});

	it('calls surfaceFailure with willRetry=false for a PermanentError', async () => {
		mockedHandlePREvent.mockRejectedValue(new PermanentError('permanent'));
		const message = makeMessage();
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, true, false, 1, 3, 'permanent');
	});

	it('processes multiple messages in a batch independently', async () => {
		mockedHandlePREvent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second fails'));

		const messageA = makeMessage({ prNumber: 1 });
		const messageB = makeMessage({ prNumber: 2 });
		const batch = makeBatch([messageA, messageB]);

		await worker.queue(batch, env);

		expect(messageA.ack).toHaveBeenCalledOnce();
		expect(messageB.retry).toHaveBeenCalledOnce();
	});

	it('does not let a failure in one message prevent processing of the next', async () => {
		mockedHandlePREvent.mockRejectedValueOnce(new Error('first fails')).mockResolvedValueOnce(undefined);

		const messageA = makeMessage({ prNumber: 1 });
		const messageB = makeMessage({ prNumber: 2 });
		const batch = makeBatch([messageA, messageB]);

		await worker.queue(batch, env);

		expect(messageA.retry).toHaveBeenCalledOnce();
		expect(messageB.ack).toHaveBeenCalledOnce();
	});

	it('acks and reports exhaustion on the final retry attempt', async () => {
		mockedHandlePREvent.mockRejectedValue(new Error('still failing'));
		const message = makeMessage({}, /* attempts */ 3);
		const batch = makeBatch([message]);

		await worker.queue(batch, env);

		expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, false, false, 3, 3, 'still failing');
		expect(message.ack).toHaveBeenCalledOnce();
		expect(message.retry).not.toHaveBeenCalled();
	});
});

/**
 * Messages reach the dead-letter queue only when the worker died outside the
 * normal failure path — nothing was reported to the PR, so the drain has to
 * surface it. Without this consumer those jobs vanished silently.
 */
describe('dead-letter queue consumer', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('does not attempt to review a dead-lettered message', async () => {
		const message = makeMessage();
		await worker.queue(makeBatch([message], 'pr-review-dlq'), env);

		expect(mockedHandlePREvent).not.toHaveBeenCalled();
		expect(message.retry).not.toHaveBeenCalled();
	});

	it('logs the job loudly enough to find who it belonged to', async () => {
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const message = makeMessage({ prNumber: 42, headSha: 'deadbeefcafe' });

		await worker.queue(makeBatch([message], 'pr-review-dlq'), env);

		const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
		expect(logged).toContain('Dead-lettered');
		expect(logged).toContain('test-owner/test-repo #42');
		expect(logged).toContain('deadbee');
	});

	it('surfaces the failure on the PR, since nothing else ever reported it', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const message = makeMessage();

		await worker.queue(makeBatch([message], 'pr-review-dlq'), env);

		expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, false, false, 1, 3, expect.stringContaining('did not finish'));
	});

	it('acks so the dead-letter queue drains instead of accumulating forever', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const message = makeMessage();

		await worker.queue(makeBatch([message], 'pr-review-dlq'), env);

		expect(message.ack).toHaveBeenCalledOnce();
	});

	it('drains the rest of the batch even if surfacing one failure throws', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(surfaceFailure).mockRejectedValueOnce(new Error('github is down'));

		const broken = makeMessage({ prNumber: 1 });
		const healthy = makeMessage({ prNumber: 2 });

		await expect(worker.queue(makeBatch([broken, healthy], 'pr-review-dlq'), env)).resolves.toBeUndefined();

		expect(broken.ack).toHaveBeenCalledOnce();
		expect(healthy.ack).toHaveBeenCalledOnce();
	});
});
