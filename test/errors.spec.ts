import { describe, expect, it } from 'vitest';
import { PermanentError } from '../src/errors';

describe('PermanentError', () => {
	it('forwards the cause to the base Error', () => {
		const original = new Error('decryption failed');
		const err = new PermanentError('wrapper message', { cause: original });
		expect(err.cause).toBe(original);
		expect(err.name).toBe('PermanentError');
		expect(err.message).toBe('wrapper message');
	});

	it('works without options', () => {
		const err = new PermanentError('no cause');
		expect(err.cause).toBeUndefined();
	});
});
