# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in AlphaPR, please **do not open a public issue**. Instead, report it privately:

- **Preferred:** [GitHub Security Advisories](https://github.com/Ekojoecovenant/alphapr/security/advisories/new) — allows a private discussion and coordinated disclosure.
- **Alternative:** open a regular issue titled "Security contact needed" with no details, and I'll follow up privately.

Please include as much detail as you can: steps to reproduce, affected versions, and potential impact.

## Response Expectations

This is a solo-maintained open source project. I'll aim to acknowledge reports within a few days and work with you on a fix and disclosure timeline. There's no bug bounty — this is a best-effort commitment, not a formal SLA.

## Scope

AlphaPR handles sensitive data on behalf of installations:

- **OpenRouter API keys** — encrypted (AES-GCM) at rest in Cloudflare D1, decrypted only in-memory during a review
- **GitHub App private key and OAuth secrets** — stored in Cloudflare's secret store, never in the repository or database
- **Webhook payloads** — verified via HMAC-SHA256 signature before any processing

Reports related to any of the above, or to the OAuth/setup flow's authentication and authorization logic, are especially welcome.

## Supported Versions

AlphaPR follows semantic versioning from v1.0.0 onward. Security fixes are backported to the latest minor release; older minor versions are not maintained. If you're self-hosting, stay on the latest `v1.x` tag.
