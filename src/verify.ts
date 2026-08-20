export async function verifySignature(secret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
	if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
		return false;
	}

	const encoder = new TextEncoder();

	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

	// Convert the hex signature from the header into bytes
	const sigHex = signatureHeader.slice('sha256='.length);
	const sigBytes = hexToBytes(sigHex);
	if (!sigBytes) return false;

	// crypto.subtle.verify recomputes the HMAC over rawBody and
	// compares it to sigBytes in constant time
	return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(rawBody));
}

function hexToBytes(hex: string): Uint8Array | null {
	if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;

	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}

	return bytes;
}
