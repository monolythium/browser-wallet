// Phase 6 — about-page metadata. Holds the version + commit constants
// that aren't readable at runtime (the wallet's own manifest version is,
// via chrome.runtime.getManifest, but the SDK and Sprintnet chain
// identifiers aren't). Update these in lockstep with the corresponding
// pnpm-lock + chain-registry sync commits.

import { TESTNET_69420 } from "@monolythium/core-sdk";

/** SDK package version. Mirrors mono-core-sdk/packages/ts/package.json
 *  `version`. Bump alongside any SDK sync that bumps the package
 *  version field. */
export const SDK_PACKAGE_VERSION = "0.3.9";

/** SDK commit short SHA. Mirrors `git -C mono-core-sdk rev-parse --short
 *  HEAD` at the time of the last upstream sync. The wallet's
 *  pnpm-lock.yaml resolves the SDK from the workspace path, so this
 *  constant exists purely for the About-page version readout. */
export const SDK_COMMIT_SHORT = "0a91be5";

/** Expected Sprintnet genesis hash — the wallet's authoritative pin for
 *  GAP #11 (orphan-fork defense). Operator probes that return a
 *  different hash for block 0 are marked "untrusted chain" and skipped
 *  by every RPC-dispatch path (balance, fee, send, indexer).
 *
 *  Mirrors the SDK chain-registry snapshot (see
 *  SDK_REGISTRY_GENESIS_HASH below). The two are duplicated so the
 *  About page can surface a warning if a future SDK sync drifts the
 *  registry's value out from under the wallet — in that case the pin
 *  takes precedence and the human reviewer decides whether to bump it.
 *
 *  Current value tracks mono-core commit `f7236197` (2026-05-27 fresh
 *  genesis cut, v0.0.6-testnet rollout). The live chain has since
 *  regenesised several times (mono-core `b7ebf657` → genesis
 *  `0x8085c869…`, the value `lyth_chainStats` reports today), and SDK
 *  0.3.9 bundles a different intermediate snapshot (`0xad64…`). Bumping
 *  this security pin is a human-reviewer decision; the About-page drift
 *  banner surfaces the mismatch and the live-registry fetch shows the
 *  current GitHub-registry value alongside it. */
export const SPRINTNET_GENESIS_HASH =
  "0xe868b8f0c671499d77d5b56404e87fc3c541c5f4777a0b1b03191a0e056f047c";

/** SDK chain-registry's current snapshot of the same hash. Surfaced on
 *  the About page when this differs from SPRINTNET_GENESIS_HASH so the
 *  reviewer notices a registry-vs-pin drift on the next sync. */
export const SDK_REGISTRY_GENESIS_HASH: string = TESTNET_69420.genesis_hash;

/** Sprintnet chain id (decimal, for display). */
export const SPRINTNET_CHAIN_ID_DEC: number = TESTNET_69420.chain_id;

/** Sprintnet chain id (hex, `0x`-prefixed) — the form the popup passes
 *  around as `chainId`. Derived from the SDK registry decimal so it
 *  tracks any future re-chain. */
export const SPRINTNET_CHAIN_ID_HEX: string =
  "0x" + TESTNET_69420.chain_id.toString(16);

/** §25.2 item 7 — static finality-posture label for the send/confirm
 *  screen. There is no per-tx finality RPC, so this is a cheap static
 *  row keyed off the active chain id. Native LythiumDAG-BFT sends settle
 *  at anchor level (a DAG anchor is the user-facing finality unit per
 *  the anchor-terminology lock); foreign chains the wallet relays to get
 *  the neutral "depends on destination chain" copy. */
export function finalityPostureFor(chainIdHex: string): string {
  const normalised = chainIdHex.toLowerCase();
  if (normalised === SPRINTNET_CHAIN_ID_HEX.toLowerCase()) {
    return "Anchor-level (LythiumDAG-BFT)";
  }
  return "Depends on destination chain";
}

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

/** Monoscan explorer base for a testnet-69420 transaction (hash-routed SPA).
 *  The wallet only links txs whose canonical hash it knows — its own sent
 *  txs. Received / indexer-only activity rows carry no tx hash and get no
 *  link (honest absence; never synthesize a hash). */
export const MONOSCAN_TX_BASE = "https://monoscan.xyz/#/tx/";

/** Build the Monoscan URL for a canonical transaction hash. */
export function monoscanTxUrl(txHash: string): string {
  return `${MONOSCAN_TX_BASE}${txHash}`;
}

/** Monoscan address (wallet) page base. Takes a bech32m address — `mono…`
 *  for accounts, `monoc…` for clusters — never the raw `0x` form. */
export const MONOSCAN_ADDRESS_BASE = "https://monoscan.xyz/#/wallet/";

/** Build the Monoscan address-page URL for a bech32m address. */
export function monoscanAddressUrl(bech32mAddr: string): string {
  return `${MONOSCAN_ADDRESS_BASE}${bech32mAddr}`;
}
