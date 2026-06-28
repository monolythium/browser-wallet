// About-page metadata. Holds the version + commit constants
// that aren't readable at runtime (the wallet's own manifest version is,
// via chrome.runtime.getManifest, but the SDK and the testnet chain
// identifiers aren't). Update these in lockstep with the corresponding
// pnpm-lock + chain-registry sync commits.

import { TESTNET_69420 } from "@monolythium/core-sdk";

/** Build-time-injected version of the installed `@monolythium/core-sdk`
 *  (Vite `define` reads node_modules/.../package.json `version`). `declare`
 *  is type-only and erased before bundling, so the define replaces only the
 *  usage below. Falls back to "unknown" when the read fails. */
declare const __SDK_INSTALLED_VERSION__: string;

/** SDK package version — the ACTUALLY-INSTALLED dependency version, injected
 *  at build time so it can never drift from the hardcoded literal again
 *  (previously pinned to a stale "0.3.9"). No commit SHA is shown: the
 *  installed package.json carries no gitHead, so version-only is the honest
 *  readout. */
export const SDK_PACKAGE_VERSION: string =
  typeof __SDK_INSTALLED_VERSION__ === "string"
    ? __SDK_INSTALLED_VERSION__
    : "unknown";

/** Expected testnet genesis hash — the wallet's authoritative pin for
 *  GAP #11 (orphan-fork defense). Operator probes that return a
 *  different chain genesis hash are marked "untrusted chain" and skipped
 *  by every RPC-dispatch path (balance, fee, send, indexer).
 *
 *  Mirrors the SDK chain-registry snapshot (see
 *  SDK_REGISTRY_GENESIS_HASH below). The two are duplicated so the
 *  About page can surface a warning if a future SDK sync drifts the
 *  registry's value out from under the wallet — in that case the pin
 *  takes precedence and the human reviewer decides whether to bump it.
 *
 *  Current value = the 2026-06-28 v2 re-genesis (protocore v0.2.4-testnet,
 *  mono-core @ 862f6bc0), where `lyth_chainStats.genesisHash`
 *  reports the registry identity hash below. CONFIRMED 2026-06-28 against
 *  the live 2×10 operator fleet (chain-registry pin follows).
 *  The installed SDK (0.5.2) registry snapshot (`TESTNET_69420.genesis_hash`)
 *  and SDK_REGISTRY_GENESIS_HASH below are both pinned to this same 0xaabb
 *  re-genesis value, so there is no SDK-vs-pin lag at present; the About drift
 *  banner only surfaces if a future SDK sync drifts the registry value out from
 *  under this pin. Bumping this security pin is a human-reviewer decision; the
 *  live-registry fetch shows the current GitHub-registry value alongside. */
export const TESTNET_GENESIS_HASH =
  "0xaabb0f1ea0e9cae9dcc4fbd3e2af577c3568b209061207f919d159c2ab4ba995";

/** Current block-0 header hash for the same chain. This is intentionally
 *  separate from TESTNET_GENESIS_HASH: `lyth_chainStats.genesisHash`
 *  exposes the chain identity hash used by the registry / p2p binding,
 *  while `eth_getBlockByNumber("0x0", false).hash` is the EVM-facing block
 *  header hash. They are not the same value (verified against the live v0.2.4
 *  chain, genesis 0xaabb0f1e…). */
export const TESTNET_BLOCK0_HASH =
  "0xd0181ed88345a8849f6633120bd6139a037ebf5036af264a9fb02414bbbb941d";

/** SDK chain-registry's current snapshot of the same hash. Surfaced on
 *  the About page when this differs from TESTNET_GENESIS_HASH so the
 *  reviewer notices a registry-vs-pin drift on the next sync. Pinned to
 *  the v0.2.4-testnet re-genesis value (2026-06-28) so it does not lag
 *  behind the installed SDK snapshot (`TESTNET_69420.genesis_hash`), which
 *  is bumped on the next SDK rebuild/publish. */
export const SDK_REGISTRY_GENESIS_HASH: string =
  "0xaabb0f1ea0e9cae9dcc4fbd3e2af577c3568b209061207f919d159c2ab4ba995";

/** The testnet chain id (decimal, for display). */
export const TESTNET_CHAIN_ID_DEC: number = TESTNET_69420.chain_id;

/** The testnet chain id (hex, `0x`-prefixed) — the form the popup passes
 *  around as `chainId`. Derived from the SDK registry decimal so it
 *  tracks any future re-chain. */
export const TESTNET_CHAIN_ID_HEX: string =
  "0x" + TESTNET_69420.chain_id.toString(16);

/** §25.2 item 7 — static finality-posture label for the send/confirm
 *  screen. There is no per-tx finality RPC, so this is a cheap static
 *  row keyed off the active chain id. Native LythiumDAG-BFT sends settle
 *  at anchor level (a DAG anchor is the user-facing finality unit per
 *  the anchor-terminology lock); foreign chains the wallet relays to get
 *  the neutral "depends on destination chain" copy. */
export function finalityPostureFor(chainIdHex: string): string {
  const normalised = chainIdHex.toLowerCase();
  if (normalised === TESTNET_CHAIN_ID_HEX.toLowerCase()) {
    return "Anchor-level (Starfish-C)";
  }
  return "Depends on destination chain";
}

/** Pitch lines for the About + "Why Monolythium" surfaces — kept here so copy
 *  tweaks land in one place and the pages stay declarative. Approved public
 *  8-pillar differentiation copy; each body closes with a "This wallet …"
 *  sentence (the constant carries title + body only). The About card renders
 *  titles only; the Why-Monolythium page renders the full body. */
export const WALLET_PITCH: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Post-quantum from the first block.",
    body: `Every transaction is admitted under ML-DSA-65 (NIST FIPS 204) and nothing else — no secp256k1 acceptance path, no hybrid mode, no swap-at-mainnet migration. The signatures protecting your funds are quantum-resistant from genesis. This wallet signs every transaction with ML-DSA-65 and keeps a separate SLH-DSA (FIPS 205) key — a different cryptographic family — as an emergency backup.`,
  },
  {
    title: "No EVM. Real programs, deterministically executed.",
    body: `Monolythium does not run the Ethereum Virtual Machine. Contracts compile to a deterministic RISC-V target, so execution is fast and auditable. A read-only slice of Ethereum-style RPC is kept for tooling compatibility, but the mutating and simulation calls are rejected — there is no EVM execution behind them. This wallet speaks the chain's native methods directly and never pretends an EVM call will work.`,
  },
  {
    title: "Trust anchored to genesis, not to whoever answers.",
    body: `The wallet carries the chain's genesis identity and checks every operator against it. An operator on a different or forked chain is marked Not verified, and the wallet won't trust its data or route your transactions through it — even if it's online and fast. You aren't trusting a server because it replied; you're trusting it because it proved it's on your chain. This wallet verifies each operator's genesis before using it, and tells you plainly when one can't be trusted.`,
  },
  {
    title: "Live numbers, or nothing — never invented ones.",
    body: `Every operator status, balance, and figure the wallet shows is read live from the chain. When the chain doesn't expose something, the wallet hides that field entirely rather than showing a placeholder or a guessed value. You never see a comforting number that isn't real. This wallet probes operators in real time, shows honest absence over fake data, and surfaces each node's actual risk.`,
  },
  {
    title: "An open marketplace of operator clusters.",
    body: `Validation runs on distributed-validator clusters — seven active operators plus three on standby, with a seven-of-ten signing threshold — published openly so you can see who is securing the network. Concentration is capped per operator and per wallet by enforced on-chain limits. (The 100-cluster, 1,000-position scale is a growth target the design is built for, not a number claimed today.) This wallet lets you browse clusters, see their health and makeup, and delegate to the ones you choose.`,
  },
  {
    title: "Native token standards.",
    body: `Tokens, NFTs, and vaults are first-class chain primitives — native MRC-20, MRC-721, MRC-1155, and MRC-4626. The standards your assets follow are part of the chain itself. This wallet reads and handles these native standards directly.`,
  },
  {
    title: "Defined as much by what it refuses.",
    body: `A chain's character is in its boundaries. Monolythium has no on-chain governance to capture, no perpetuals or margin engine, and a one-way cordon between public and private funds enforced at both admission and execution. The restraint is the point. This wallet respects those boundaries and never exposes functionality the chain deliberately doesn't have.`,
  },
  {
    title: "Many vaults, one keystore — and built for agents.",
    body: `Hold several independent vaults behind one master password, each with its own approval rules. Multi-signature today lives in the keystore itself — the threshold and roster are part of your encrypted wallet, with approvals as ML-DSA-65 signatures; a native on-chain m-of-n spend path is being wired next. And because the network ships an open-source MCP server, AI assistants can already read live chain state and run typed, auditable routines, with an opt-in in-wallet Copilot building toward that, off by default until it's ready. This wallet gives you multi-vault custody now, and is being built toward native on-chain multisig and an opt-in agentic Copilot.`,
  },
];

/** Static external links surfaced from the About page. URLs are stable
 *  project endpoints; the About page is read-only / informational. */
export const EXTERNAL_LINKS: ReadonlyArray<{
  label: string;
  url: string;
  /** Icon glyph name (see popup/Icon `IconName`), or "mono-mark" for the
   *  brand "M". Typed as a plain string so this shared module stays free of
   *  UI imports; the render sites cast it to IconName. */
  icon: string;
  /** Brand tint for the "M" marks — Monolythium purple / Mono Labs teal.
   *  Other links use the default icon color. */
  brandColor?: string;
}> = [
  {
    label: "Monolythium",
    url: "https://monolythium.com/",
    icon: "mono-mark",
    brandColor: "#7C5CFC",
  },
  {
    label: "Mono Labs",
    url: "https://mono-labs.org/",
    icon: "mono-mark",
    brandColor: "#2DD4BF",
  },
  {
    label: "Ecosystem",
    url: "https://monolythium.com/ecosystem",
    icon: "grid",
  },
  {
    label: "Documentation",
    url: "https://docs.monolythium.com/",
    icon: "book",
  },
  {
    label: "Whitepaper",
    url: "https://monolythium.com/whitepaper",
    icon: "contract",
  },
  {
    label: "GitHub",
    url: "https://github.com/monolythium/",
    icon: "github",
  },
  {
    label: "Privacy",
    url: "https://monolythium.com/legal/privacy",
    icon: "lock",
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
