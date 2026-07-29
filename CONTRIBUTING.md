# Contributing to AlphaPR

Thanks for considering a contribution. AlphaPR is a small, actively developed project — here's how to get set up and what's expected of a PR.

## Local setup

```bash
git clone https://github.com/Ekojoecovenant/alphapr.git
cd alphapr
pnpm install
```

For local development against real GitHub/OpenRouter/Cloudflare resources, follow the [Self-hosting](README.md#self-hosting) section of the README to register your own GitHub App and provision your own Cloudflare resources. There's currently no fully mocked local dev environment — most of this project's logic (webhook signatures, GitHub API calls, D1 state) is tightly coupled to real Cloudflare and GitHub infrastructure.

## Before opening a PR

```bash
pnpm lint
pnpm test
```

Both must pass. If you're changing behavior (not just internal structure or docs), consider whether it needs test coverage — see `test/` for the existing patterns (`diff.spec.ts`, `llm.spec.ts`, `setup.spec.ts`).

## Branching and commits

- Branch per feature/fix: `feat/short-description`, `fix/short-description`, `chore/short-description`
- Commit messages: present-tense, descriptive first line (`feat: add per-installation severity threshold`, not `updated stuff`)
- Open the PR against `main`; AlphaPR will review its own PR — that's intentional dogfooding, not a bug

## What to expect in review

This project has been built through heavy iteration with AI-assisted code review (AlphaPR itself, plus CodeRabbit). Findings from either bot aren't automatically authoritative — they get triaged and discussed, not blindly applied. Feel free to push back on a bot finding in your own PR if you think it's wrong; that's a normal part of the process here.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md) instead — please don't open a public issue for a vulnerability.
