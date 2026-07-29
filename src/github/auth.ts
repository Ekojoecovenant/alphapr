import { PermanentError } from '../errors';

function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Build a JWT proving we are the GitHub App. Valid ~10 minutes. */
export async function createAppJWT(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60,      // 60s in the past to tolerate clock drift
      exp: now + 9 * 60,  // GitHub max is 10 min; stay under it
      iss: appId,
    })
  );

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );

  return `${data}.${base64url(signature)}`;
}

/** Exchange the App JWT for an installation access token (~1 hour). */
export async function getInstallationToken(
  appJwt: string,
  installationId: number
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphpr", // GitHub rejects requests without a UA
      },
    }
  );

  if (res.status === 401 || res.status === 404) {
    throw new PermanentError(
      `Installation auth failed (revoked or removed?): ${res.status} ${(await res.text()).slice(0, 300)}`
    );
  }
  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}