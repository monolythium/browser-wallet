// Item 4 (0-flash) — persisted last-known LIVE balance.
//
// The action popup is destroyed on minimize and re-mounted on restore, so on a
// fresh mount `balanceLythoshi` starts null and the live `eth_getBalance` read
// is a full SW IPC round-trip away. Persisting the last confirmed live balance
// lets the Home hero + Assets row seed that figure almost immediately on the
// home flip — shown dimmed + "last known" (the existing balanceStale labeling)
// until the live fetch reconfirms — instead of a "0.00" flash or a skeleton.
//
// NO-MOCK (binding): a record is written ONLY from a confirmed live read
// (App.refreshBalance's success branch). It is keyed by addr+chainId and is
// IGNORED on any mismatch. It is NEVER a synthesized / zero / mock fallback,
// and is always surfaced as last-known (never as a live figure) until the live
// fetch confirms. When no valid matching record exists the caller falls through
// to the loading skeleton — never a fabricated number.

/** Persisted last-known live balance for one (address, chain) scope. */
export interface LastKnownBalance {
  /** The live `eth_getBalance` result, verbatim hex quantity (lythoshi). */
  balanceHex: string;
  /** Lowercased 0x address the balance was read for (mismatch ⇒ ignore). */
  addr: string;
  /** chainId hex the balance was read on (mismatch ⇒ ignore). */
  chainId: string;
  /** Epoch ms of the live read (informational; not used for expiry today). */
  ts: number;
}

/** Per-(address, chain) storage key. Mirrors the activity cache key shape
 *  (`mono.activity.<addr>.<chain>`); addresses + chainId never contain a dot. */
export function lastKnownBalanceKey(addrLower: string, chainIdHex: string): string {
  return `mono.balance.${addrLower}.${chainIdHex}`;
}

/** Build the record written after a confirmed live read. */
export function makeLastKnownBalance(
  balanceHex: string,
  addrLower: string,
  chainIdHex: string,
  ts: number,
): LastKnownBalance {
  return { balanceHex, addr: addrLower, chainId: chainIdHex, ts };
}

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;

/** Tolerant parse of a persisted record. Malformed / absent → null. */
export function parseLastKnownBalance(raw: unknown): LastKnownBalance | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.balanceHex !== "string" ||
    !HEX_QUANTITY.test(r.balanceHex) ||
    typeof r.addr !== "string" ||
    typeof r.chainId !== "string" ||
    typeof r.ts !== "number" ||
    !Number.isFinite(r.ts)
  ) {
    return null;
  }
  return { balanceHex: r.balanceHex, addr: r.addr, chainId: r.chainId, ts: r.ts };
}

/** Return the seed `balanceHex` ONLY when the record is present, valid, and its
 *  (addr, chainId) match the active scope. Mismatch / malformed / absent → null
 *  so the caller falls through to the loading skeleton (never a fabricated
 *  number, never another scope's balance). */
export function selectSeedBalanceHex(
  raw: unknown,
  addrLower: string,
  chainIdHex: string,
): string | null {
  const rec = parseLastKnownBalance(raw);
  if (rec === null) return null;
  if (rec.addr !== addrLower || rec.chainId !== chainIdHex) return null;
  return rec.balanceHex;
}
