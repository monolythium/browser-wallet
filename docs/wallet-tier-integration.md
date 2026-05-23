# Wallet Tier Integration — Browser Extension

> How `browser-wallet` participates (and deliberately does not participate)
> in the cross-app shared wallet store. Cross-reference:
> `repos/monolythium/stele-desktop/docs/wallet-architecture.md` (tier
> model) and `repos/monolythium/stele-desktop/docs/security-cross-app-wallet-visibility.md`
> (threat model).

## Where wallets live in the extension

Browser-wallet stores keys in the browser's extension storage with
`chrome.storage.local` (or equivalent) — encrypted at rest under a
passphrase. This is Tier 2 in the cross-app tier model.

The extension's storage area is sandboxed per-extension by the browser.
Other extensions cannot read it.

## Why browser-wallet does NOT directly read `~/.lyth_mcp/wallets.json`

Extensions *can* request the `nativeMessaging` permission and read local
files via a paired native helper. We deliberately don't do this for the
shared wallet store. Reasons:

1. **Permission UX is alarming.** Adding "Read your computer's files" to
   a browser extension trips installation warnings users have learned to
   take seriously. The risk/reward is bad: the gain is "wallets show up
   without import"; the cost is a permission that's worth phishing.

2. **A compromised extension becomes a wallet-drain extension.**
   Extensions update from the store with much less user attention than
   native apps. An extension that quietly gains compromised version
   could read every wallet in the shared store and exfiltrate
   ciphertexts for offline cracking.

3. **The browser is a hostile environment.** Web content cannot reach
   extension storage, but the extension itself loads remote analytics,
   fonts, etc. Every dependency you add is a vector. Keeping the
   filesystem boundary closed limits blast radius.

4. **No production browser-extension wallet does this.** MetaMask,
   Phantom, Rabby — all keep keys inside the extension's own storage. We
   should follow that prior art unless there's a forcing function.

## How wallets get into the extension — the two supported paths

### Path A — Generate / import inside the extension (status quo)

Standard wallet flows: create a new 24-word PQM-1 mnemonic, or import an
existing one via paste. Encrypted under user passphrase + stored in
`chrome.storage.local`.

### Path B — Native Messaging to lyth_mcp (future, opt-in)

If the user *explicitly* wants the extension to use the same wallets as
their desktop apps, they install:

1. A small **native helper** (a signed binary, separately distributed),
   which the browser launches via `chrome.runtime.connectNative`.
2. The helper speaks MCP to a local lyth_mcp instance.
3. The extension never directly touches `~/.lyth_mcp/wallets.json`. It
   speaks to the native helper, which speaks to lyth_mcp, which owns the
   file boundary.

This adds two security boundaries (extension ↔ helper, helper ↔ MCP)
both of which can be audited independently. Users who don't want this
never install the helper and never see the prompt.

**Status:** Designed for post-v1. Out of scope for the initial browser-
wallet release. When it lands, it gets its own threat model PR.

## What the extension does *not* do

- Open `~/.lyth_mcp/wallets.json` directly.
- Run lyth_mcp inside the extension runtime.
- Spawn arbitrary child processes from the extension.
- Use `nativeMessaging` without an explicit user opt-in flow and a signed
  helper binary published outside the browser store.

## If you find a PR proposing direct file read from the extension

Reject it. Refer to this document. The cost/benefit was analyzed against
the user-visible permission warnings and the blast radius of a
compromised extension, and the answer is *no direct file read*.

## Trust boundaries

| Boundary | Enforced by | Notes |
|---|---|---|
| Extension storage is isolated from other extensions | Browser sandbox | Same property the major wallet extensions rely on |
| Extension cannot reach `~/.lyth_mcp/wallets.json` | Default (we never ask for the permission) | Intentional |
| Future Native Messaging path is opt-in + signed helper | User installs the helper separately | Defense in depth |

## Pointer

The full tier model and per-app decision matrix lives at:
`repos/monolythium/stele-desktop/docs/wallet-architecture.md` and
`repos/monolythium/stele-desktop/docs/security-cross-app-wallet-visibility.md`.
