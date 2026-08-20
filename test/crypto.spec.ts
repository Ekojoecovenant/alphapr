import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto';

const KEY_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_B = 'f'.repeat(64);

describe('encryptSecret / decryptSecret', () => {
	it('round-trips a short ASCII string', async () => {
		const plaintext = 'sk-ant-api03-1234567890abcdef';
		const stored = await encryptSecret(plaintext, KEY_A);
		expect(await decryptSecret(stored, KEY_A)).toBe(plaintext);
	});

	it('round-trips a string with unicode and emoji', async () => {
		const plaintext = 'cléé 🙌 日本語 héllo wörld 🔐';
		const stored = await encryptSecret(plaintext, KEY_A);
		expect(await decryptSecret(stored, KEY_A)).toBe(plaintext);
	});

	it('round-trips an empty string', async () => {
		const stored = await encryptSecret('', KEY_A);
		expect(await decryptSecret(stored, KEY_A)).toBe('');
	});

	it('produces different ciphertext for the same plaintext and key (random IV)', async () => {
		const first = await encryptSecret('same value', KEY_A);
		const second = await encryptSecret('same value', KEY_A);
		expect(first).not.toBe(second);
	});

	it('rejects ciphertext that has been tampered with', async () => {
		const stored = await encryptSecret('secret api key', KEY_A);
		const [ivB64, ctB64] = stored.split('.');
		const corrupted = `${ivB64}.${(ctB64[0] === 'A' ? 'B' : 'A') + ctB64.slice(1)}`;
		expect(corrupted).not.toBe(stored);
		await expect(decryptSecret(corrupted, KEY_A)).rejects.toThrow();
	});

	it('rejects decryption with the wrong master key', async () => {
		const stored = await encryptSecret('sk-ant-api03-abcdef', KEY_A);
		await expect(decryptSecret(stored, KEY_B)).rejects.toThrow();
	});

	it('rejects a master key that is too short', async () => {
		await expect(encryptSecret('value', 'a'.repeat(63))).rejects.toThrow('Master key must be exactly 64 hex characters (32 bytes)');
	});

	it('rejects a master key that is too long', async () => {
		await expect(encryptSecret('value', 'a'.repeat(65))).rejects.toThrow('Master key must be exactly 64 hex characters (32 bytes)');
	});

	it('rejects a master key containing non-hex characters', async () => {
		await expect(encryptSecret('value', `${'g'}${'0'.repeat(63)}`)).rejects.toThrow(
			'Master key must be exactly 64 hex characters (32 bytes)',
		);
	});

	it('accepts an uppercase-hex master key (validated case-insensitively)', async () => {
		const plaintext = 'sk-ant-api03-uppercase-key';
		const stored = await encryptSecret(plaintext, KEY_A.toUpperCase());
		expect(await decryptSecret(stored, KEY_A.toUpperCase())).toBe(plaintext);
	});

	it('rejects a stored value with no dot separator', async () => {
		await expect(decryptSecret('not-an-encrypted-secret', KEY_A)).rejects.toThrow('Malformed encrypted secret');
	});

	it('rejects a stored value with an empty ciphertext segment', async () => {
		await expect(decryptSecret('c2VjcmV0.', KEY_A)).rejects.toThrow('Malformed encrypted secret');
	});

	it('rejects a stored value with an empty iv segment', async () => {
		await expect(decryptSecret('.c2VjcmV0', KEY_A)).rejects.toThrow('Malformed encrypted secret');
	});
});
