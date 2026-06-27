# browser-wallet

> Monolythium Wallet — Manifest V3 browser extension. Holds Monolythium keys, signs transactions for dapps over an EIP-1193 provider.

**License:** Apache-2.0 · **Status:** preview (testnet only) · **Stack:** Manifest V3 · React 19 · TypeScript · Vite + `@crxjs/vite-plugin`

## Install

**[Add to your browser — Chrome Web Store →](https://chromewebstore.google.com/detail/hendlkmpghhmhmggjebkpbedncpepkgj)** (Chrome · Brave · Edge). Canonical extension ID `hendlkmpghhmhmggjebkpbedncpepkgj`, publisher **Mono Labs R&D LLC** — verify both before installing. Firefox (AMO) is still planned. Runs against testnet 69420.

---

## Status: preview

Functional Manifest V3 extension with substantive crypto + EIP-1193 implementation, but not yet production-grade. Set expectations before adopting:

- **Chain target is testnet.** Monolythium mainnet has not launched. Anything you connect to here runs against the public testnet today; mainnet activation is gated on separate protocol milestones.
- **Live on the Chrome Web Store** (Chromium browsers) — see [Install](#install) above. Firefox (AMO) is not yet published; for Firefox or development, build from source and load `dist/` as an unpacked extension.
- **Fallback operator RPCs are placeholders** (`192.0.2.0/24` — IETF TEST-NET-1). The wallet's primary chain-config source is the SDK chain-registry; the bundled `FALLBACK_OPERATORS_2026_05_25` array in `src/background/networks.ts` only kicks in when the registry is unreachable. To override with real RPCs, copy [`examples/operators.json.example`](./examples/operators.json.example) to `examples/operators.json` (gitignored).
- **SDK comes from npm, pinned exact.** `package.json` pins `@monolythium/core-sdk@0.4.9` (exact, not `^0.4.9`) — the SDK is pre-1.0, semver isn't a stability contract there, and a silent patch upgrade could shift wire-format bytes (vault layout, address derivation). Every wallet release bumps the SDK pin deliberately.

Watch this repo for the first non-preview tag before treating any build as production-grade.

---

## What this is

A Manifest V3 browser extension that:

- Holds **ML-DSA-65** Monolythium keys (post-quantum signature scheme) and BIP-39-derived EVM keys for the EVM-supported chain track.
- Signs transactions for dapps via a standard **EIP-1193 provider** injected into every page.
- Talks to Monolythium nodes through the typed **`@monolythium/core-sdk`** client.
- Routes every destructive operation through a **popup approval flow** with password gate + hold-to-reveal recovery-phrase UX.

The architecture splits into three contexts as Manifest V3 requires:

- **Service worker** (`src/background/`) — keystore, network config, EIP-1193 request dispatcher, tx history, balance consensus, signing.
- **Popup** (`src/popup/`) — React 19 UI for accounts, send / receive, networks, approvals, settings, connected sites.
- **Content scripts** (`src/content/`) — `provider.ts` injects the EIP-1193 provider into the page (`MAIN` world); `bridge.ts` (isolated world) shuttles messages between the page and the service worker.

## Prerequisites

To inspect, audit, or develop:

- **Node** 22+
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)
- A Chromium-based browser (Chrome, Brave, Edge, Arc) or Firefox 109+

## Quick start

For external readers — the most useful actions today are auditing the source and reading the approval / keystore paths:

```bash
git clone https://github.com/monolythium/browser-wallet.git
cd browser-wallet

# Read the EIP-1193 provider boundary (the page-side surface)
less src/content/provider.ts

# Read the keystore + lockout ladder
less src/background/keystore.ts
less src/background/keystore-mldsa.ts

# Read the approval-request dispatcher
less src/background/approvals.ts

# Read the popup approval flow + its tests
less src/popup/pages/Pending.test.ts
```

With the sibling `mono-core-sdk` checkout in place:

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (65 test files)

# Development build — Vite serves at http://localhost:5173 (strict)
pnpm dev

# Production build — loads from dist/
pnpm build
```

To load the unpacked extension in Chrome:

1. `pnpm build`
2. Open `chrome://extensions`
3. Toggle "Developer mode"
4. "Load unpacked" → select the `dist/` directory

To override the fallback operator RPCs locally:

```bash
cp examples/operators.json.example examples/operators.json
# Edit examples/operators.json with your real RPC endpoints.
# This file is gitignored.
```

## Repo layout

```
browser-wallet/
├── manifest.json                # MV3 manifest — alarms + storage perms only
├── src/
│   ├── background/              # Service worker
│   │   ├── service-worker.ts    # Entry point + EIP-1193 dispatcher
│   │   ├── keystore.ts          # BIP-39 / EVM-track keystore
│   │   ├── keystore-mldsa.ts    # ML-DSA-65 keystore
│   │   ├── approvals.ts         # Request → popup approval flow
│   │   ├── networks.ts          # Chain config + FALLBACK_OPERATORS_*
│   │   ├── connected-sites.ts   # Per-origin dapp permissions
│   │   ├── balance-consensus.ts # Multi-RPC balance reconciliation
│   │   ├── ws-client.ts         # WebSocket subscription client
│   │   ├── native-*.ts          # Native-chain feature clients
│   │   └── *.test.ts            # Vitest coverage
│   ├── popup/                   # React 19 popup UI
│   │   ├── pages/               # About, ConnectedSites, Delegations,
│   │   │                        # ForgotPassword, ImportWallet,
│   │   │                        # NetworkDetail, Operators, Pending, ...
│   │   ├── components/          # Reusable UI pieces
│   │   └── App.tsx
│   ├── content/
│   │   ├── provider.ts          # EIP-1193 provider (MAIN-world injection)
│   │   └── bridge.ts            # Isolated-world bridge to the service worker
│   ├── shared/                  # Pure helpers shared across all contexts
│   │   ├── bech32m.ts           # Address encoding per ADR-0038
│   │   ├── activity.ts          # Tx-history model
│   │   ├── two-tier-features.ts # Feature-flag surface
│   │   └── ...
│   └── lib/                     # Smaller utilities
└── examples/
    └── operators.json.example   # Shape for the local-only operators.json
```

## Crypto stack

- **`@monolythium/core-sdk`** — the ML-DSA-65 (FIPS-204) backend, BIP-39 -> ML-DSA-65 seed derivation, address derivation, and tx signing
- **`@noble/post-quantum`** for the ML-DSA-65 (FIPS-204) signature primitives
- **`@noble/ciphers`** + **`@noble/hashes`** for the password-derived KEK + AES-GCM vault encryption (and SHAKE256 / keccak)
- **`@scure/bip39`** for the 24-word recovery mnemonic (BIP-39 -> ML-DSA-65 derivation — no BIP-32 HD / secp256k1 path)

No custom crypto. All sensitive operations go through the noble/scure stack — audited, well-known, RustCrypto-aligned.

## Security model (in brief)

- The encrypted vault lives in `chrome.storage` keyed by the password-derived KEK.
- The unlocked seed lives in service-worker memory for the duration of one operation, then is zeroed.
- Every destructive operation routes through the popup approval flow (no silent signing).
- The EIP-1193 provider is `MAIN`-world; the bridge is isolated-world. They communicate only via the documented postMessage channel.
- Wrong-password lockout ladder: 5 / 10 / 20 attempts → progressively longer cooldowns.
- Recovery-phrase reveal requires re-password + a hold-to-reveal UX.

The full set of in-scope vulnerability categories is enumerated in [`SECURITY.md`](./SECURITY.md).

## Related projects

- [**monolythium.com**](https://monolythium.com) — protocol home, whitepaper, ecosystem links.
- [**`monolythium/mono-core-sdk`**](https://github.com/monolythium/mono-core-sdk) — public TypeScript + Rust SDK consumed here as `@monolythium/core-sdk`.
- [**`monolythium/monoscan`**](https://github.com/monolythium/monoscan) — public block explorer the wallet links out to for tx receipts.
- [**`monolythium/monarch-desktop`**](https://github.com/monolythium/monarch-desktop) — operator console (distinct app — for running nodes, not for end users).
- [**`monolythium/monarch-os-talos`**](https://github.com/monolythium/monarch-os-talos) — operator node OS.
- [**`monolythium/mono-studio`**](https://github.com/monolythium/mono-studio) — public developer toolchain for MRV contracts and MRC assets.
- [**`monolythium/lyth_mcp`**](https://github.com/monolythium/lyth_mcp) — public MCP server for the broader ecosystem.
- **`monolythium/mono-core`** *(private)* — the chain itself.
- **`monolythium/desktop-wallet`** *(private)* — sibling consumer wallet (Tauri-based native desktop app).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short version: run the two gates (`pnpm typecheck`, `pnpm test`) locally before opening a PR — there is no public CI workflow that runs them today. Do not reintroduce real production RPC IPs to `FALLBACK_OPERATORS_*`; do not bypass the popup approval flow; do not loosen the content-script boundary.

## Security

See [`SECURITY.md`](./SECURITY.md). Short version: vulnerability reports to `security@monolythium.com`, **not** the public issue tracker. The in-scope categories cover keystore exfiltration, lockout-ladder bypass, EIP-1193 silent signing, cross-world message forgery, popup injection, chain-config corruption, and wrong-chain-replay.

## License

Released under the Apache License, Version 2.0. See [`LICENSE`](./LICENSE) for the full text.
