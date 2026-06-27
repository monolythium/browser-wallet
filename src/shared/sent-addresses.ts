// Durable per-(vault, chain) log of addresses this wallet has sent to.
//
// Why this exists: the "first-time recipient" warning was backed only by the
// indexer activity cache + the 5-minute-TTL pending rows, so a recipient
// flipped back to "new" (re-warning) once the pending row expired and before
// an indexer refresh cached the confirmed send. This log is written on every
// successful send and never TTL-evicted, so a known recipient stays known for
// the life of the install. The warning is a phishing-friction hint, not a hard
// security control.
//
// P5-007 (DiD): each entry carries a wallet-authored HMAC tag (keystore
// `computeSentAddrTagV4`, keyed by a MEK-derived sub-key). The warning is
// suppressed only for entries whose tag VERIFIES — so an attacker who can write
// `chrome.storage.local` (A4: offline disk-write) but lacks the in-session MEK
// cannot plant a well-formed entry that suppresses the warning for their
// address. The HMAC is advisory-only: it gates the warning, never a send.
//
// This module is pure (keys, parse, append, canonical MAC message — testable);
// the keyed HMAC compute/verify lives in the keystore (where the MEK is), the
// chrome.storage round-trip is done by the SW (write) and the popup asks the SW
// to verify (read), since the MEK is SW-only.

/** Max recipients retained per (vault, chain) — newest-first, capped so the
 *  log can't grow unbounded. 500 distinct recipients is far beyond normal use. */
export const SENT_ADDRESSES_CAP = 500;

/** Per-vault, per-chain key. `vaultAddrLower` is the sender's 0x address,
 *  lowercased; `chainIdHex` the active chain. */
export function sentAddressesKey(vaultAddrLower: string, chainIdHex: string): string {
  return `mono.sent-addrs.${vaultAddrLower}.${chainIdHex}`;
}

/** One stored entry: the lowercased 0x recipient + its wallet HMAC tag (hex). */
export interface SentAddrEntry {
  /** Lowercased 0x recipient address. */
  a: string;
  /** Hex HMAC-SHA256 integrity tag authored by the wallet (keystore). */
  t: string;
}

const MESSAGE_PREFIX = "mono-sent-addr.v1";
// Unit Separator — cannot appear in a hex 0x address or a hex chain id, so the
// field join is unambiguous (no length-extension / field-confusion between the
// three components).
const FIELD_SEP = "\x1f";

/** Canonical MAC message binding an entry to (sender vault, chain, recipient).
 *  All three fields are lowercased. The sender vault address + chain are bound
 *  in so a tag can never be transplanted across vaults or chains (the keystore
 *  sub-key is MEK-derived and shared across vaults). */
export function canonicalSentAddrMessage(
  vaultAddrLower: string,
  chainIdHex: string,
  recipientLower: string,
): string {
  return [
    MESSAGE_PREFIX,
    vaultAddrLower.toLowerCase(),
    chainIdHex.toLowerCase(),
    recipientLower.toLowerCase(),
  ].join(FIELD_SEP);
}

/** Parse the stored value into a list of HMAC'd entries. Tolerant: any shape
 *  that isn't the current `{v:1, entries:[{a,t}]}` form — including the legacy
 *  `{addrs:[…]}` shape, null, or malformed input — yields an EMPTY list, so the
 *  warning simply fires (fail-safe) and legacy entries are untrusted until the
 *  user re-sends (which re-writes them with a fresh wallet tag; no migration,
 *  no auto-trust). Structurally-bad entries are filtered individually. */
export function parseSentEntries(raw: unknown): SentAddrEntry[] {
  if (raw === null || typeof raw !== "object") return [];
  const o = raw as { v?: unknown; entries?: unknown };
  if (o.v !== 1 || !Array.isArray(o.entries)) return [];
  const out: SentAddrEntry[] = [];
  for (const e of o.entries) {
    if (e === null || typeof e !== "object") continue;
    const { a, t } = e as { a?: unknown; t?: unknown };
    if (
      typeof a === "string" &&
      a.length > 0 &&
      typeof t === "string" &&
      t.length > 0
    ) {
      out.push({ a, t });
    }
  }
  return out;
}

/** Append an entry (lowercased addr + its tag) newest-first, deduped by addr
 *  (a repeat send replaces the stored tag and moves it to the front), capped at
 *  `SENT_ADDRESSES_CAP`. Pure. */
export function addSentEntry(
  existing: SentAddrEntry[],
  recipientLower: string,
  tag: string,
): SentAddrEntry[] {
  const a = recipientLower.toLowerCase();
  const next: SentAddrEntry[] = [
    { a, t: tag },
    ...existing.filter((e) => e.a !== a),
  ];
  return next.length > SENT_ADDRESSES_CAP ? next.slice(0, SENT_ADDRESSES_CAP) : next;
}
