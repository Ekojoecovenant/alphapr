// AES-GCM encryption for stored API keys.
// Master key comes from the KEY_ENCRYPTION_SECRET env secret (32-byte hex).

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("Master key must be exactly 64 hex characters (32 bytes)");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importMasterKey(secretHex: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Encrypt a plaintext string → "iv.ciphertext" (both base64). */
export async function encryptSecret(plaintext: string, masterSecretHex: string): Promise<string> {
  const key = await importMasterKey(masterSecretHex);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // GCM standard: 96-bit IV, fresh every time
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

/** Decrypt "iv.ciphertext" → plaintext. Throws if tampered or wrong key. */
export async function decryptSecret(stored: string, masterSecretHex: string): Promise<string> {
  const [ivB64, ctB64] = stored.split(".");
  if (!ivB64 || !ctB64) throw new Error("Malformed encrypted secret");
  const key = await importMasterKey(masterSecretHex);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(ctB64)
  );
  return new TextDecoder().decode(plaintext);
}