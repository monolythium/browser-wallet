// Durable per-(vault, chain) log of addresses this wallet has sent to.
//
// Why this exists: the "first-time recipient" warning was backed only by the
// indexer activity cache + the 5-minute-TTL pending rows, so a recipient
// flipped back to "new" (re-warning) once the pending row expired and before
// an indexer refresh cached the confirmed send. This log is written on every
// successful send and never TTL-evicted, so a known recipient stays known for
// the life of the install. It's wiped on uninstall — acceptable (the warning
// is a phishing-friction hint, not a security invariant), and the existing
// contact/registered + activity-cache signals still cover fresh installs.
//
// Storage shape mirrors the activity cache convention: a versioned object
// under a per-(vault, chain) key. Keys + parsing live here (pure, testable);
// the chrome.storage round-trip is done by the SW (write) and the popup (read).

/** Max recipients retained per (vault, chain) — newest-first, capped so the
 *  log can't grow unbounded. 500 distinct recipients is far beyond normal use. */
export const SENT_ADDRESSES_CAP = 500;

/** Per-vault, per-chain key. `vaultAddrLower` is the sender's 0x address,
 *  lowercased; `chainIdHex` the active chain. */
export function sentAddressesKey(vaultAddrLower: string, chainIdHex: string): string {
  return `mono.sent-addrs.${vaultAddrLower}.${chainIdHex}`;
}

/** Parse the stored value into a lowercased 0x address list. Tolerant: any
 *  malformed shape yields an empty list (the warning simply fires as before). */
export function parseSentAddresses(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object") return [];
  const a = (raw as { addrs?: unknown }).addrs;
  if (!Array.isArray(a)) return [];
  return a.filter((x): x is string => typeof x === "string");
}

/** Append a recipient (lowercased) newest-first, deduped, capped. Pure. */
export function addToSentList(existing: string[], recipient0x: string): string[] {
  const lower = recipient0x.toLowerCase();
  if (existing.includes(lower)) return existing;
  const next = [lower, ...existing];
  return next.length > SENT_ADDRESSES_CAP ? next.slice(0, SENT_ADDRESSES_CAP) : next;
}

/** True when `recipient0x` is in the sent log (case-insensitive). */
export function isSentAddress(list: string[], recipient0x: string): boolean {
  return list.includes(recipient0x.toLowerCase());
}
