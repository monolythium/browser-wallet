# Contributing to Monolythium Wallet (browser)

Thanks for considering a contribution. This is a **preview** Manifest V3 browser extension that holds Monolythium keys and signs transactions for dapps via an EIP-1193 provider. The threat model is meaningful — please respect the boundaries below.

## Before opening a pull request

Run both gates locally — there is no public CI workflow that exercises them today:

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
```

Keep both green before opening the PR.

## What we're looking for

- **Bug fixes** in `src/` — welcome any time.
- **Doc fixes** in `README.md`, `CONTRIBUTING.md`, `SECURITY.md` — welcome any time.
- **Test coverage improvements** for the EIP-1193 provider, the background service worker, the keystore, and the popup approval flow.
- **Additional networks** in `src/background/networks.ts` — Monolythium chains only. Public testnet entries should use `192.0.2.0/24` (TEST-NET-1 reserved) as placeholder RPCs; real operator endpoints belong in the local-only `examples/operators.json` (gitignored).
- **Improvements to the lockout ladder, password-strength meter, or auto-lock policy.**

## What we'll push back on

- **Reintroducing real production RPC IPs.** `FALLBACK_OPERATORS_2026_05_25` in `src/background/networks.ts` is intentionally populated with `192.0.2.0/24` placeholders. The wallet's primary RPC source is the SDK chain-registry — the fallback is for when that's unreachable. Real operator endpoints belong in a local `examples/operators.json` only.
- **Direct private-key exfiltration paths.** The keystore lives behind a password-derived KEK; signing operations decrypt the seed into in-memory state for the duration of one operation and zero it afterward. Don't add an export-private-key path that bypasses the password gate. Recovery-phrase reveal goes through the existing flow (re-prompt + hold-to-reveal).
- **Content-script changes that loosen the EIP-1193 provider boundary.** The provider lives in `MAIN` world; the bridge in isolated world. Don't merge them. Don't add new postMessage channels that bypass the request/approval flow.
- **Adding broad host permissions to `manifest.json`.** Today the extension uses `permissions: ["alarms", "storage"]` and content scripts on `<all_urls>` for the EIP-1193 injection. Any expansion needs a specific, documented justification in the PR.
- **Tool-assisted code without an honest commit author.** If you used local tooling to write code, sign the commit with YOUR identity, not the tool's. We rewrote the public history to scrub a previous slip on this point.

## Commit + PR conventions

- Plain English in the imperative ("Add foo", "Fix bar") — no emoji, no `:phase:` or colon-prefixes.
- One logical change per commit when practical. Squash before merge if a PR grew several commits during review.
- For changes touching the keystore, the service worker, the popup approval flow, or the EIP-1193 provider, link the relevant test file in the PR description.

## Security

If you've found a vulnerability, please **do not open a public issue**. Email `security@monolythium.com` and we'll coordinate disclosure. See [`SECURITY.md`](./SECURITY.md) for the full policy and in-scope finding categories.

## Code of conduct

Be respectful. Disagree on technical merit. Don't be a jerk.
