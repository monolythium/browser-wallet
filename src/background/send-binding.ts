// Send-idempotency bindings — one user confirmation → the bytes signed for it.
//
// WHY BYTES AND NOT A NONCE. A retry must re-broadcast the SAME signed
// transaction, never re-sign. ML-DSA signing is hedged (`@noble/post-quantum`
// draws fresh randomness unless told otherwise), so re-signing the same payload
// at the same nonce yields different bytes and a different tx hash. In the
// window where the original is still pooled the chain answers
// `ReplaceUnderpriced`, which `tx-mldsa.ts` classifies as a deterministic
// `reject` and throws — reporting a send that is about to land as a failure,
// and inviting the user to retry again. Re-broadcasting identical bytes instead
// yields `DuplicateKnown` / `AlreadyConsumed`, both classified `already-known`,
// counted as acceptance, and answered with the original hash.
//
// STORAGE (D1). `chrome.storage.local`, not session: a browser crash mid-send
// followed by a retry is a real double-send path, and session storage is gone
// by then. The cost is that for a short window the disk holds a VALID,
// UNBROADCAST signed transaction — the user authorised it, so the exposure is
// narrow, but it is why the binding is deleted the moment the send completes
// rather than left to expire. The TTL only reaps orphans from a worker that
// died before it could clean up.
//
// WHAT IT HOLDS. The nonce, the signed wire bytes, the canonical tx hash, and a
// timestamp. Nothing else — no password, no mnemonic, no key material. The
// wire bytes are the same bytes already handed to every operator, so they are
// public by the time they matter. A test pins this shape.

/** Versioned `chrome.storage.local` key for the binding map. */
export const STORAGE_KEY_SEND_BINDINGS = "mono.send.binding.v1";

/** D4 — 15 minutes, 3x the 5-minute pending-nonce window this must outlive.
 *  A binding that expires while the user is still looking at the error screen
 *  would send "Try again" down the normal path and re-derive the nonce, which
 *  is the exact defect this closes. Eager deletion is the real cleanup. */
export const SEND_BINDING_TTL_MS = 15 * 60 * 1000;

/** The signed transaction produced for one confirmation. */
export interface SendBinding {
  /** The nonce that was signed. Returned to the caller so a re-broadcast still
   *  reports the nonce the transaction actually carries. */
  nonceHex: string;
  /** The signed wire bytes, re-broadcast verbatim on a retry. */
  wireHex: string;
  /** The canonical inner-tx hash the chain indexes. */
  txHashHex: string;
  /** Written at bind time; the TTL is measured from here. */
  ts: number;
}

export type SendBindingMap = Record<string, SendBinding>;

/** True only for a fully-formed binding. A truncated or partially-written entry
 *  must never be handed back — re-broadcasting an incomplete transaction is
 *  worse than taking the normal path. */
function isWellFormed(v: unknown): v is SendBinding {
  if (v === null || typeof v !== "object") return false;
  const b = v as Partial<SendBinding>;
  return (
    typeof b.nonceHex === "string" &&
    typeof b.wireHex === "string" &&
    typeof b.txHashHex === "string" &&
    typeof b.ts === "number"
  );
}

function isLive(b: SendBinding, now: number): boolean {
  return now - b.ts <= SEND_BINDING_TTL_MS;
}

/** The binding for `key`, or null if absent, malformed, or past its TTL. */
export function readValidBinding(
  map: SendBindingMap,
  key: string,
  now: number,
): SendBinding | null {
  const raw = map[key];
  if (!isWellFormed(raw)) return null;
  return isLive(raw, now) ? raw : null;
}

/** `map` with `key` bound. Does not mutate the input. */
export function withBinding(
  map: SendBindingMap,
  key: string,
  binding: SendBinding,
): SendBindingMap {
  return { ...map, [key]: binding };
}

/** `map` without `key`. Does not mutate the input; an absent key is a no-op. */
export function withoutBinding(map: SendBindingMap, key: string): SendBindingMap {
  const { [key]: _dropped, ...rest } = map;
  return rest;
}

/** Drop everything malformed or past its TTL. The backstop for a worker that
 *  died between writing a binding and deleting it. */
export function pruneExpired(map: SendBindingMap, now: number): SendBindingMap {
  const out: SendBindingMap = {};
  for (const [key, value] of Object.entries(map)) {
    if (isWellFormed(value) && isLive(value, now)) out[key] = value;
  }
  return out;
}

async function loadMap(): Promise<SendBindingMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_SEND_BINDINGS], (res) => {
      const raw = res?.[STORAGE_KEY_SEND_BINDINGS];
      resolve(raw && typeof raw === "object" ? (raw as SendBindingMap) : {});
    });
  });
}

async function saveMap(map: SendBindingMap): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_SEND_BINDINGS]: map }, () => resolve());
  });
}

/** The live binding for `key`, or null. */
export async function readSendBinding(
  key: string,
  now: number,
): Promise<SendBinding | null> {
  return readValidBinding(await loadMap(), key, now);
}

/** Bind `key` to `binding`, pruning orphans in the same write. */
export async function writeSendBinding(
  key: string,
  binding: SendBinding,
): Promise<void> {
  const map = await loadMap();
  await saveMap(withBinding(pruneExpired(map, binding.ts), key, binding));
}

/** Drop `key` — called the moment a send completes, success or failure, so the
 *  signed bytes do not sit on disk waiting for the TTL. */
export async function deleteSendBinding(key: string): Promise<void> {
  const map = await loadMap();
  if (!(key in map)) return;
  await saveMap(withoutBinding(map, key));
}
