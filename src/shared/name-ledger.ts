// Best-effort local ledger of `.mono` names registered / accepted through THIS
// wallet, keyed by owner address (chrome.storage.local).
//
// There is NO on-chain owned-names enumeration: regular register/accept emit no
// events and the chain's reverse lookup is single last-write-wins, so a
// `lyth_namesOf(address)` reader does not exist (a Nayiem/SDK-gate). This ledger
// is therefore a convenience, NOT a source of truth — every entry is reconciled
// against the chain (forward-resolve → owner == you?) before being shown, and
// the UI labels it as best-effort. It only ever contains names the wallet itself
// successfully submitted; it never fabricates a list.
//
// Pure data helpers live here (unit-testable); the service worker owns the
// chrome.storage read/write + the chain reconcile.

export const STORAGE_KEY_NAME_LEDGER = "mono.names.ledger";

/** Max entries retained per address — bounds storage against a tampered blob or
 *  a very active registrant. Oldest entries drop first. */
export const MAX_LEDGER_ENTRIES_PER_ADDRESS = 200;

export interface OwnedNameEntry {
  /** Canonical lowercase `.mono` name. */
  name: string;
  /** SDK category ("human" | "agent" | …) at record time. */
  category: string;
  /** Epoch ms when the wallet recorded it (informational). */
  addedAt: number;
}

/** address(lowercase) → the names this wallet registered/accepted for it. */
export type NameLedger = Record<string, OwnedNameEntry[]>;

function isEntry(v: unknown): v is OwnedNameEntry {
  if (v === null || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.name === "string" &&
    e.name.length > 0 &&
    typeof e.category === "string" &&
    typeof e.addedAt === "number"
  );
}

/** Validate an unknown blob as a NameLedger; returns null on any structural
 *  failure so the caller can fall back to an empty ledger. */
export function validateNameLedger(raw: unknown): NameLedger | null {
  if (raw === null || typeof raw !== "object") return null;
  const out: NameLedger = {};
  for (const [addr, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) return null;
    const clean: OwnedNameEntry[] = [];
    for (const item of list) {
      if (!isEntry(item)) return null;
      clean.push({ name: item.name, category: item.category, addedAt: item.addedAt });
    }
    out[addr.toLowerCase()] = clean;
  }
  return out;
}

/** Add (or refresh) an owned-name entry for `address`, de-duped by name. The
 *  newest record wins; the list is capped at {@link MAX_LEDGER_ENTRIES_PER_ADDRESS}
 *  (oldest dropped). Returns a NEW ledger (pure). */
export function addOwnedNameEntry(
  ledger: NameLedger,
  address: string,
  entry: OwnedNameEntry,
): NameLedger {
  const key = address.toLowerCase();
  const name = entry.name.toLowerCase();
  const prev = ledger[key] ?? [];
  const withoutDup = prev.filter((e) => e.name.toLowerCase() !== name);
  const next = [...withoutDup, { ...entry, name }];
  // Keep the most recent MAX entries (drop oldest by insertion order).
  const capped = next.length > MAX_LEDGER_ENTRIES_PER_ADDRESS
    ? next.slice(next.length - MAX_LEDGER_ENTRIES_PER_ADDRESS)
    : next;
  return { ...ledger, [key]: capped };
}

/** The recorded names for `address` (newest last), or []. */
export function getOwnedNames(ledger: NameLedger, address: string): OwnedNameEntry[] {
  return ledger[address.toLowerCase()] ?? [];
}

/** Reconciled on-chain status of a ledger name. */
export type OwnedNameStatus = "owned" | "transferred" | "not-found" | "unknown";

export interface ReconciledOwnedName extends OwnedNameEntry {
  status: OwnedNameStatus;
}
