/** An error that retrying cannot fix — the job should be acked, not retried. */
export class PermanentError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message);
		this.name = 'PermanentError';
	}
}
