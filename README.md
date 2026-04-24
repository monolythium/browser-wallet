# browser-wallet

Monolythium browser wallet (Chrome, Firefox, Brave — Manifest V3)

> Part of the [Monolythium](https://monolythium.com) ecosystem — a sovereign Layer-1 for finality-first apps.

---

## What this is

A Manifest V3 browser extension that holds Monolythium v2 keys and signs transactions for dapps via an EIP-1193 provider. Built on a Rust-native L1 (LythiumDAG-BFT consensus); the wallet talks to any Monolythium node through the `@monolythium/core-sdk` typed client. Early scaffold — features arrive in stages.

## Who this is for

- End users who want to hold and move MNLX tokens directly from their browser.
- Dapp developers integrating Monolythium in a frontend who need a reference wallet that exposes a standard EIP-1193 provider.

## Install

Chrome Web Store / Firefox AMO listings: **coming soon**. Until the first signed release lands, install from source via the build steps below and load the `dist/` folder as an unpacked extension.

## Getting started

Once a release is published, install from your browser's extension store and click the Monolythium icon in the toolbar to open the wallet popup.

For now, see "Building from source" — the development build hot-reloads in any Chromium browser.

## Documentation

- Project site: <https://monolythium.com>
- Public docs: coming soon at <https://docs.monolythium.com>

## Building from source

```bash
pnpm install
pnpm dev          # HMR via @crxjs/vite-plugin
pnpm build        # produces dist/ — load as unpacked extension
pnpm typecheck    # tsc --noEmit
```

Then in your browser:

- Chrome / Brave: open `chrome://extensions`, enable Developer mode, click "Load unpacked", point at `dist/`.
- Firefox: open `about:debugging`, "This Firefox", "Load Temporary Add-on", select `dist/manifest.json`.

Requirements: Node 22+, pnpm 9+.

## Contributing

We welcome contributions. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the guidelines.

## Security

Found a vulnerability? Please **do not open a public issue**. Email security@monolythium.com instead. See [SECURITY.md](./SECURITY.md) for the full disclosure policy.

## License

MIT
