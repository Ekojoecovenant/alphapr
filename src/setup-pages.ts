const BASE_STYLES = `
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --accent: #2f81f7;
    --accent-hover: #1f6feb;
    --success: #3fb950;
    --error: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    max-width: 560px;
    margin: 60px auto;
    padding: 0 20px;
    line-height: 1.5;
  }
  h1, h2 { font-weight: 600; }
  a { color: var(--accent); }
  label { display: block; margin-top: 20px; font-weight: 600; font-size: 14px; }
  .hint { font-weight: 400; color: var(--text-dim); font-size: 12px; margin: 4px 0 0; }
  input, select {
    width: 100%;
    padding: 10px 12px;
    margin: 6px 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 14px;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  button {
    margin-top: 24px;
    padding: 12px 28px;
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: var(--accent-hover); }
  .err { color: var(--error); }
  .success { color: var(--success); }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 24px;
    margin-top: 16px;
  }
`;

function shell(title: string, body: string): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · AlphaPR</title>
<style>${BASE_STYLES}</style></head><body>${body}</body></html>`;
}

export function errorPage(message: string, opts: { status?: number; showRetry?: boolean } = {}): string {
	return shell(
		'Error',
		`
    <h1>AlphaPR</h1>
    <div class="card">
      <p class="err">${message}</p>
      ${opts.showRetry !== false ? `<p><a href="/setup">Start over</a></p>` : ''}
    </div>
  `,
	);
}

export function noInstallationsPage(): string {
	return shell(
		'Get started',
		`
    <h1>AlphaPR</h1>
    <div class="card">
      <p>No AlphaPR installations found for your account.</p>
      <p><a href="https://github.com/apps/alphapr-ai">Install AlphaPR</a> first, then return here.</p>
    </div>
  `,
	);
}

export interface ConfigFormData {
	installationOptions: string; // pre-rendered <option> tags
	currentModel: string;
	currentSeverity: string;
	currentTone: string;
	currentIgnorePaths: string;
	formToken: string;
}

export function configFormPage(data: ConfigFormData): string {
	return shell(
		'Configure',
		`
    <h1>AlphaPR</h1>
    <p class="hint">Configure your installation below.</p>
    <div class="card">
      <form method="POST" action="/setup/save">
        <label>Installation
          <select name="installationId">${data.installationOptions}</select>
        </label>
        <label>OpenRouter API key
          <input name="apiKey" type="password" placeholder="Leave blank to keep your existing key">
          <p class="hint">Required on first setup. Leave blank when editing settings to keep your current key.</p>
        </label>
        <label>Model
          <input name="model" type="text" value="${data.currentModel}">
          <p class="hint">Any OpenRouter model. Fast, non-reasoning models recommended.</p>
        </label>
        <label>Severity threshold
          <select name="severityThreshold">
            <option value="all" ${data.currentSeverity === 'all' ? 'selected' : ''}>All (major, minor, nits)</option>
            <option value="minor" ${data.currentSeverity === 'minor' ? 'selected' : ''}>Minor and above</option>
            <option value="major" ${data.currentSeverity === 'major' ? 'selected' : ''}>Major only</option>
          </select>
        </label>
        <label>Review tone
          <select name="reviewTone">
            <option value="thorough" ${data.currentTone === 'thorough' ? 'selected' : ''}>Thorough</option>
            <option value="concise" ${data.currentTone === 'concise' ? 'selected' : ''}>Concise</option>
          </select>
        </label>
        <label>Ignore paths
          <input name="ignorePaths" type="text" value="${data.currentIgnorePaths}" placeholder="dist/,*.lock,*.min.js">
          <p class="hint">Comma-separated. Supports "dir/" prefixes and "*.ext" suffixes.
          If you have access to multiple installations, this form only pre-fills the FIRST one's saved config — check the Installation dropdown above carefully before saving, especially if you manage more than one.</p>
        </label>
        <input type="hidden" name="token" value="${data.formToken}">
        <button type="submit">Save configuration</button>
      </form>
    </div>
  `,
	);
}

export function successPage(login: string, installationId: number): string {
	return shell(
		'Saved',
		`
    <h1>AlphaPR</h1>
    <div class="card">
      <p class="success">✅ Saved</p>
      <p>AlphaPR is configured for <strong>${login}</strong> (installation ${installationId}).</p>
      <p>Open or update a PR to trigger a review.</p>
    </div>
  `,
	);
}

export function landingPage(): string {
	return shell(
		'Home',
		`
    <h1>AlphaPR</h1>
    <p class="hint">A BYOK AI PR reviewer that comments on the exact lines it's talking about — and remembers what it already said.</p>
    <div class="card">
      <p><a href="https://github.com/apps/alphapr-ai">Install the GitHub App</a>, then visit <a href="/setup">/setup</a> to configure your key.</p>
      <p><a href="https://github.com/Ekojoecovenant/alphapr">View source & docs on GitHub →</a></p>
    </div>
  `,
	);
}
