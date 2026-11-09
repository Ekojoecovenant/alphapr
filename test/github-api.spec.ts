import { describe, expect, it } from 'vitest';
import { safeNextPageUrl } from '../src/github/api';

/**
 * The next-page URL comes from the server, so it is data. Following it blindly
 * would let a compromised or misconfigured response walk the installation token
 * to another origin.
 */
describe('safeNextPageUrl', () => {
	it('follows a page link that stays on the API origin', () => {
		expect(safeNextPageUrl('https://api.github.com/installation/repositories?page=2')).toBe(
			'https://api.github.com/installation/repositories?page=2',
		);
	});

	it('refuses a link to another host, so the token cannot be forwarded', () => {
		expect(safeNextPageUrl('https://evil.example/installation/repositories?page=2')).toBeNull();
		expect(safeNextPageUrl('https://api.github.com.evil.example/x')).toBeNull();
	});

	it('refuses a downgrade to plain http and anything that is not a URL', () => {
		expect(safeNextPageUrl('http://api.github.com/installation/repositories?page=2')).toBeNull();
		expect(safeNextPageUrl('/installation/repositories?page=2')).toBeNull();
		expect(safeNextPageUrl('not a url')).toBeNull();
	});
});
