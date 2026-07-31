import { encryptSecret } from "./crypto";
import { PROVIDERS } from "./review/provider-types";

// ── HMAC signing for state params and form tokens ──

export async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacVerify(data: string, sig: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(data, secret);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(body: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AlphaPR Setup</title>
<style>body{font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px;color:#222}
label{display:block;margin-top:16px;font-weight:600;font-size:14px}
.hint{font-weight:400;color:#666;font-size:12px;margin:2px 0 0}
input,select{width:100%;padding:8px;margin:6px 0;box-sizing:border-box}
button{margin-top:20px;padding:10px 24px;background:#1a7f37;color:#fff;border:0;border-radius:6px;cursor:pointer}
.err{color:#b32020}</style></head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

// ── Route handler: returns a Response for /setup* paths, null otherwise ──

export async function handleSetup(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  // 1) Entry point: mint a browser-bound nonce, redirect to GitHub OAuth
  if (url.pathname === "/setup" && request.method === "GET") {
    const ts = Date.now().toString();
    const nonce = randomHex(16);
    const payload = `${ts}.${nonce}`;
    const state = `${payload}.${await hmacSign(payload, env.SETUP_SIGNING_SECRET)}`;

    const redirect = new URL("https://github.com/login/oauth/authorize");
    redirect.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    redirect.searchParams.set("redirect_uri", `${url.origin}/setup/callback`);
    redirect.searchParams.set("state", state);

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirect.toString(),
        "Set-Cookie": `alphapr_setup_nonce=${nonce}; HttpOnly; Secure; Path=/setup; Max-Age=600; SameSite=Lax`,
      },
    });
  }

  // 2) OAuth callback: verify state + nonce, exchange code, render form
  if (url.pathname === "/setup/callback" && request.method === "GET") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const [ts, nonce, sig] = state.split(".");
    const cookieNonce = getCookie(request, "alphapr_setup_nonce");

    if (
      !code || !ts || !nonce || !sig ||
      !(await hmacVerify(`${ts}.${nonce}`, sig, env.SETUP_SIGNING_SECRET))
    ) {
      return html(`<p class="err">Invalid or missing OAuth state. <a href="/setup">Start over</a>.</p>`, 400);
    }
    if (!cookieNonce || cookieNonce !== nonce) {
      return html(`<p class="err">This link wasn't started from your browser. <a href="/setup">Start over</a>.</p>`, 400);
    }
    if (Date.now() - parseInt(ts, 10) > 10 * 60 * 1000) {
      return html(`<p class="err">This link expired. <a href="/setup">Start over</a>.</p>`, 400);
    }

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    let tokenData: { access_token?: string };
    try {
      tokenData = (await tokenRes.json()) as { access_token?: string };
    } catch {
      return html(`<p class="err">Failed to parse GitHub's response. <a href="/setup">Try again</a>.</p>`, 502);
    }
    if (!tokenData.access_token) {
      return html(`<p class="err">GitHub authorization failed. <a href="/setup">Try again</a>.</p>`, 400);
    }

    const instRes = await fetch("https://api.github.com/user/installations", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "alphapr",
      },
    });
    if (!instRes.ok) {
      return html(`<p class="err">Could not fetch your installations (${instRes.status}).</p>`, 400);
    }
    const instData = (await instRes.json()) as {
      installations: { id: number; account: { login: string } }[];
    };

    if (instData.installations.length === 0) {
      return html(
        `<p>No AlphaPR installations found for your account. <a href="https://github.com/apps/alphapr-ai">Install AlphaPR</a> first, then return here.</p>`
      );
    }

    const existingConfig = await env.DB.prepare(
      `SELECT model, severity_threshold, review_tone, ignore_paths, provider FROM installations WHERE installation_id = ?`
    )
      .bind(instData.installations[0].id)
      .first<{ model: string; severity_threshold: string; review_tone: string; ignore_paths: string; provider: string }>();

    const allowedPairs = instData.installations
      .map((i) => `${i.id}:${i.account.login}`)
      .join(",");
    const exp = (Date.now() + 10 * 60 * 1000).toString();
    const payload = `${allowedPairs}|${exp}`;
    const formToken = `${payload}.${await hmacSign(payload, env.SETUP_SIGNING_SECRET)}`;

    const options = instData.installations
      .map((i) => `<option value="${i.id}">${esc(i.account.login)} (${i.id})</option>`)
      .join("");

    return html(`
      <h2>Configure AlphaPR</h2>
      <form method="POST" action="/setup/save">
        <label>Installation
          <select name="installationId">${options}</select>
        </label>

        <label>OpenRouter API key
          <input name="apiKey" type="password" placeholder="Leave blank to keep your existing key">
          <p class="hint">Required on first setup. Leave blank when editing settings to keep your current key.</p>
        </label>

        <label>Model
          <input name="model" type="text" value="${esc(existingConfig?.model ?? "deepseek/deepseek-v4-flash")}">
          <p class="hint">Any OpenRouter model. Fast, non-reasoning models recommended.</p>
        </label>

        <label>Severity threshold
          <select name="severityThreshold">
            <option value="all" ${existingConfig?.severity_threshold === "all" || !existingConfig ? "selected" : ""}>All (major, minor, nits)</option>
            <option value="minor" ${existingConfig?.severity_threshold === "minor" ? "selected" : ""}>Minor and above</option>
            <option value="major" ${existingConfig?.severity_threshold === "major" ? "selected" : ""}>Major only</option>
          </select>
        </label>

        <label>Review tone
          <select name="reviewTone">
            <option value="thorough" ${existingConfig?.review_tone === "thorough" || !existingConfig ? "selected" : ""}>Thorough</option>
            <option value="concise" ${existingConfig?.review_tone === "concise" ? "selected" : ""}>Concise</option>
          </select>
        </label>

        <label>Ignore paths
          <input name="ignorePaths" type="text" value="${esc(existingConfig?.ignore_paths ?? "")}" placeholder="dist/,*.lock,*.min.js">
          <p class="hint">Comma-separated. Supports "dir/" prefixes and "*.ext" suffixes. If you have multiple installations, switching the dropdown above won't reload these fields — save separately per installation if settings differ.</p>
        </label>

        <input type="hidden" name="token" value="${esc(formToken)}">
        <button type="submit">Save configuration</button>
      </form>
    `);
  }

  // 3) Save: verify token, resolve login, conditionally update key, store config
  if (url.pathname === "/setup/save" && request.method === "POST") {
    const form = await request.formData();
    const installationId = parseInt(String(form.get("installationId") ?? ""), 10);
    const apiKey = String(form.get("apiKey") ?? "").trim();
    const model = String(form.get("model") ?? "").trim();
    const severityThreshold = String(form.get("severityThreshold") ?? "all");
    const reviewTone = String(form.get("reviewTone") ?? "thorough");
    const ignorePaths = String(form.get("ignorePaths") ?? "").trim();
    const provider = String(form.get("provider") ?? "openrouter");
    const token = String(form.get("token") ?? "");

    const lastDot = token.lastIndexOf(".");
    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);

    if (!payload || !sig || !(await hmacVerify(payload, sig, env.SETUP_SIGNING_SECRET))) {
      return html(`<p class="err">Invalid form token. <a href="/setup">Start over</a>.</p>`, 400);
    }

    const [allowedPairs, exp] = payload.split("|");
    if (Date.now() > parseInt(exp, 10)) {
      return html(`<p class="err">This form expired. <a href="/setup">Start over</a>.</p>`, 400);
    }

    const match = allowedPairs
      .split(",")
      .map((pair) => {
        const idx = pair.indexOf(":");
        return { id: parseInt(pair.slice(0, idx), 10), login: pair.slice(idx + 1) };
      })
      .find((p) => p.id === installationId);

    if (!match) {
      return html(`<p class="err">You don't have access to that installation.</p>`, 403);
    }
    if (!model) {
      return html(`<p class="err">Model is required. <a href="/setup">Start over</a>.</p>`, 400);
    }
    if (!["all", "minor", "major"].includes(severityThreshold)) {
      return html(`<p class="err">Invalid severity threshold.</p>`, 400);
    }
    if (!["thorough", "concise"].includes(reviewTone)) {
      return html(`<p class="err">Invalid review tone.</p>`, 400);
    }
    if (!(PROVIDERS as readonly string[]).includes(provider)) {
      return html(`<p class="err">Invalid provider.</p>`, 400);
    }

    // Does this installation already have a key?
    const existing = await env.DB.prepare(
      `SELECT api_key_encrypted FROM installations WHERE installation_id = ?`
    )
      .bind(installationId)
      .first<{ api_key_encrypted: string | null }>();

    const hasExistingKey = !!existing?.api_key_encrypted;

    if (!apiKey && !hasExistingKey) {
      return html(
        `<p class="err">An API key is required for first-time setup. <a href="/setup">Start over</a>.</p>`,
        400
      );
    }

    if (apiKey) {
      // New or replacement key provided — encrypt and store it
      const encrypted = await encryptSecret(apiKey, env.KEY_ENCRYPTION_SECRET);
      await env.DB.prepare(
        `INSERT INTO installations
           (installation_id, account_login, api_key_encrypted, model, severity_threshold, review_tone, ignore_paths, provider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id) DO UPDATE SET
           account_login = excluded.account_login,
           api_key_encrypted = excluded.api_key_encrypted,
           model = excluded.model,
           severity_threshold = excluded.severity_threshold,
           review_tone = excluded.review_tone,
           ignore_paths = excluded.ignore_paths,
           provider = excluded.provider`
      )
        .bind(installationId, match.login, encrypted, model, severityThreshold, reviewTone, ignorePaths, provider)
        .run();
    } else {
      const current = await env.DB.prepare(
        `SELECT model, severity_threshold, review_tone, ignore_paths, provider FROM installations WHERE installation_id = ?`
      )
        .bind(installationId)
        .first<{ model: string; severity_threshold: string; review_tone: string; ignore_paths: string; provider: string }>();

      await env.DB.prepare(
        `UPDATE installations SET
           account_login = ?, model = ?, severity_threshold = ?, review_tone = ?, ignore_paths = ?, provider = ?
         WHERE installation_id = ?`
      )
        .bind(
          match.login,
          model || current?.model || "deepseek/deepseek-v4-flash",
          severityThreshold || current?.severity_threshold || "all",
          reviewTone || current?.review_tone || "thorough",
          ignorePaths,
          provider || current?.provider || "openrouter",
          installationId
        )
        .run();
    }

    return html(
      `<h2>✅ Saved</h2><p>AlphaPR is configured for <strong>${esc(match.login)}</strong> (installation ${installationId}). Open or update a PR to trigger a review.</p>`
    );
  }

  return null;
}
