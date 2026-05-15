// Phase 6 — about-page metadata. Holds the version + commit constants
// that aren't readable at runtime (the wallet's own manifest version is,
// via chrome.runtime.getManifest, but the SDK and Sprintnet chain
// identifiers aren't). Update these in lockstep with the corresponding
// pnpm-lock + chain-registry sync commits.

import { TESTNET_69420 } from "@monolythium/core-sdk";

/** SDK package version. Mirrors mono-core-sdk/packages/ts/package.json
 *  `version`. Bump alongside any SDK sync that bumps the package
 *  version field — Phase 6 ships against 0.1.0. */
export const SDK_PACKAGE_VERSION = "0.1.0";

/** SDK commit short SHA. Mirrors `git -C mono-core-sdk rev-parse --short
 *  HEAD` at the time of the last upstream sync. The wallet's
 *  pnpm-lock.yaml resolves the SDK from the workspace path, so this
 *  constant exists purely for the About-page version readout. */
export const SDK_COMMIT_SHORT = "fdd3844";

/** Expected Sprintnet genesis hash sourced from the SDK chain registry
 *  snapshot. The About page renders this and Commit 5 (GAP #11) makes
 *  the operator-health probe assert against it. */
export const SPRINTNET_GENESIS_HASH: string = TESTNET_69420.genesis_hash;

/** Sprintnet chain id (decimal, for display). */
export const SPRINTNET_CHAIN_ID_DEC: number = TESTNET_69420.chain_id;

/** Pitch lines for the About page — kept here so design tweaks land in
 *  one place and so the page itself stays declarative. Phrases mirror
 *  whitepaper §28.5 (wallet portfolio differentiation). */
export const WALLET_PITCH: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Post-quantum native",
    body: "Sprintnet signs every transaction with ML-DSA-65 (NIST FIPS 204). No legacy secp256k1 fallback, no swap-at-mainnet migration drama.",
  },
  {
    title: "Multisig built-in",
    body: "Multi-vault container ships with day-one accounts and on-chain m-of-n. No bolt-on smart-wallet — the keystore is the multisig.",
  },
  {
    title: "MCP Copilot ready",
    body: "Wallet surface is Model-Context-Protocol-aware so agentic flows (autovote, runbooks) can read state without a brittle scraper.",
  },
  {
    title: "Passkey-aware tier",
    body: "Day-one passkey + hardware tier alongside the seed-phrase path. The wallet ships toward §28.5's three-tier custody story.",
  },
];

/** Static external links surfaced from the About page. URLs are stable
 *  project endpoints; the About page is read-only / informational. */
export const EXTERNAL_LINKS: ReadonlyArray<{ label: string; url: string }> = [
  {
    label: "Whitepaper",
    url: "https://monolythium.org/whitepaper",
  },
  {
    label: "GitHub",
    url: "https://github.com/monolythium/browser-wallet",
  },
  {
    label: "Privacy policy",
    url: "https://monolythium.org/privacy",
  },
];
