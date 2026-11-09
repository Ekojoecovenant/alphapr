import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('AlphaPR worker', () => {
	it('responds to a plain GET with a liveness message', async () => {
		const request = new IncomingRequest('http://example.com');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('text/html');
		expect(await response.text()).toContain('AlphaPR');
	});

	it('refuses a webhook body larger than any payload GitHub sends', async () => {
		const request = new IncomingRequest('http://example.com', {
			method: 'POST',
			headers: { 'content-length': '21000000', 'x-github-event': 'pull_request' },
			body: '{}',
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		// Refused before the signature check, because buffering it is the cost.
		expect(response.status).toBe(413);
	});
});
