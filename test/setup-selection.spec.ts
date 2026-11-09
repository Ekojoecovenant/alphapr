import { describe, expect, it } from 'vitest';
import { pickInstallation } from '../src/setup';

/**
 * `/setup` can have several authorized installations in one form. Which one is
 * being edited has to be explicit, or the page silently shows the first one's
 * stored config under another installation's name.
 */
const installations = [
	{ id: 11, account: { login: 'first' } },
	{ id: 22, account: { login: 'second' } },
];

describe('pickInstallation', () => {
	it('uses the installation named in the query string', () => {
		expect(pickInstallation(installations, '22').account.login).toBe('second');
	});

	it('falls back to the first when nothing is named', () => {
		expect(pickInstallation(installations, null).id).toBe(11);
	});

	it('falls back rather than trusting a value it does not recognise', () => {
		expect(pickInstallation(installations, '999').id).toBe(11);
		expect(pickInstallation(installations, 'second').id).toBe(11);
		expect(pickInstallation(installations, '').id).toBe(11);
	});
});
