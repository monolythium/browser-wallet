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
// narrow, but it is why the wire bytes are discarded the moment the broadcast
// succeeds (`completeSendBinding`) rather than left to expire. The TTL only
// reaps orphans from a worker that died before it could clean up.
//
// WHAT IT HOLDS. The nonce, the signed wire bytes, the canonical tx hash, the
// accepting operator, a timestamp, and — for an account-level lookup — the
// sending address and the chain id. Nothing else: no password, no mnemonic, no
// key material. Every field is either a public chain value or a public address;
// the wire bytes are the same bytes already handed to every operator, so they
// are public by the time they matter. Two tests pin this shape — one on the
// written record and one on the completion stub, and they must move together:
// a field that survives the bind but not the completion is invisible to exactly
// the lookup the completion stub exists to serve.

/** Versioned `chrome.storage.local` key for the binding map. */
export const STORAGE_KEY_SEND_BINDINGS = "mono.send.binding.v1";

/** D4 — 15 minutes, 3x the 5-minute pending-nonce window this must outlive.
 *  A binding that expires while the user is still looking at the error screen
 *  would send "Try again" down the normal path and re-derive the nonce, which
 *  is the exact defect this closes. Eager deletion is the real cleanup. */
export const SEND_BINDING_TTL_MS = 15 * 60 * 1000;

/** The signed transaction produced for one confirmation. */
export interface SendBinding {
  /** The nonce carried by the signed bytes in `wireHex`.
   *
   *  ITS PROVENANCE DIFFERS BY SUBMIT PATH, and one field is safe ONLY because
   *  nothing interprets the value. The tracked path takes it from the local
   *  pending-nonce tracker; a direct-broadcast path would take it from the
   *  sending account's own committed nonce. Today it is stored, handed back to
   *  the caller, and used as pending-row display metadata — never compared,
   *  never sorted, never used to look anything up, and never fed to
   *  `recordSubmittedNonce` (the replay returns before reaching it).
   *
   *  THE DAY A CONSUMER NEEDS TO INTERPRET IT, this field must first carry its
   *  provenance — a tagged union, not a second nonce field, because a second
   *  field would make the replay branch on which one to trust. */
  nonceHex: string;
  /** The signed wire bytes, re-broadcast verbatim on a retry. */
  wireHex: string;
  /** The canonical inner-tx hash the chain indexes. */
  txHashHex: string;
  /** Operator that accepted the broadcast. Empty until completion; carried so
   *  a replayed answer reports the same origin the first reply did. */
  via: string;
  /** Written at bind time; the TTL is measured from here. */
  ts: number;
  /** The TRANSACTION'S SENDER — scoping for an account-level lookup ("is there
   *  an unresolved send for this account?").
   *
   *  It is the sender, not the initiating vault, because a field named for an
   *  account must hold the account. The consequence is recorded rather than
   *  hidden: a native-multisig send binds under the `monom` address, so it will
   *  NOT be found by a lookup scoped to the user's own address. That path is
   *  developer-gated with no users today; when it has some, the lookup gets
   *  extended and those surfaces need their own treatment regardless.
   *
   *  OPTIONAL, and deliberately absent from `isWellFormed`: records written
   *  before this field existed stay valid and keep replaying by key. They are
   *  merely invisible to the account lookup, and age out within the TTL. */
  from?: string;
  /** The chain the send was made on — the second half of the account lookup.
   *  Same absence semantics as `from`. */
  chainIdHex?: string;
}

export type SendBindingMap = Record<string, SendBinding>;

/** True only for a fully-formed binding. A truncated or partially-written entry
 *  must never be handed back — re-broadcasting an incomplete transaction is
 *  worse than taking the normal path. */
function isWellFormed(v: unknown): v is SendBinding {
  if (v === null || typeof v !== "object") return false;
  const b = v as Partial<SendBinding>;
  // OPTIONAL FIELDS ARE DELIBERATELY NOT CHECKED. Requiring one would invalidate
  // every record written before it existed — and "invalid" here means the caller
  // signs afresh and derives a new nonce, which is the double-send this store
  // exists to prevent. Leaving them unchecked means an older record still
  // replays correctly and is only invisible to the newer lookup.
  return (
    typeof b.nonceHex === "string" &&
    typeof b.wireHex === "string" &&
    typeof b.txHashHex === "string" &&
    typeof b.via === "string" &&
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

/** Drop `key` — used when a send FAILED to broadcast, so the signed bytes do
 *  not sit on disk waiting for the TTL. On the success path use
 *  {@link completeSendBinding} instead; see the note there. */
export async function deleteSendBinding(key: string): Promise<void> {
  const map = await loadMap();
  if (!(key in map)) return;
  await saveMap(withoutBinding(map, key));
}

/**
 * Retire `key` once the broadcast has SUCCEEDED: discard the wire bytes, keep
 * the resulting hash.
 *
 * D1 asked for eager deletion on completion, to bound how long the disk holds a
 * valid unbroadcast signed transaction. Deleting the row outright would reopen
 * the very failure this mechanism exists to close: the headline case is a
 * worker that finished everything and died BEFORE its reply landed, so a retry
 * that finds nothing takes the normal path and derives the next nonce — a
 * second transaction.
 *
 * So completion drops the sensitive half and keeps the answer. `wireHex` is
 * emptied, which satisfies D1's actual concern — no unbroadcast signed
 * transaction remains on disk — while a retry can still be answered with the
 * original hash instead of signing again. The TTL then reaps the stub.
 */
export async function completeSendBinding(
  key: string,
  txHashHex: string,
  via: string,
  now: number,
): Promise<void> {
  const map = await loadMap();
  const existing = map[key];
  if (existing === undefined) return;
  // PRESERVE the record and override only what completion changes. This was a
  // field-by-field rebuild, which silently dropped anything not named here — so
  // a field could survive the bind and vanish at completion, and the completed
  // stub is exactly what an account-level lookup reads ("did my send land?").
  // The spread fixes the PATTERN: every future field is carried without anyone
  // having to remember to add it.
  await saveMap(
    withBinding(map, key, {
      ...existing,
      wireHex: "",
      txHashHex,
      via,
      ts: now,
    }),
  );
}

/** True once the send behind this binding has landed — the bytes are gone and
 *  only the hash remains. A retry is answered from `txHashHex` and must NOT be
 *  re-broadcast (there is nothing left to broadcast). */
export function isCompleted(binding: SendBinding): boolean {
  return binding.wireHex.length === 0;
}

/** What a caller hands back at the moment its transaction is signed but not yet
 *  broadcast. Everything a replay needs; `via` and `ts` belong to the store. */
export interface SendBindingFields {
  nonceHex: string;
  wireHex: string;
  txHashHex: string;
  from?: string;
  chainIdHex?: string;
}

/** What every keyed submit resolves to, whether it signed, replayed, or was
 *  answered from a completed stub. */
export interface SendBindingResult {
  txHash: string;
  via: string;
  nonceHex: string;
}

/**
 * The bind-and-replay lifecycle for ONE keyed submit — read, replay-or-answer,
 * write, complete, and drop on failure.
 *
 * WHY A CALLBACK RATHER THAN A BUILD-AND-RETURN. The two submit paths differ in
 * a way that matters here: the single-key path's build and broadcast are FUSED
 * inside `submitMlDsaTxWithHooks`, which exposes only a between-sign-and-
 * broadcast hook, while a direct-broadcast path builds and broadcasts as two
 * separate steps. A helper that took a `build()` and did the broadcasting itself
 * would fit only the second, and forcing the first into it would mean bypassing
 * `submitMlDsaTxWithHooks` — which is what feeds the existing ordering and
 * metadata-only assertions, and which carries the 0x40 front-door guard. So the
 * caller keeps its own build+broadcast and simply calls `bind` at the right
 * moment; this owns only the binding.
 *
 * `rebroadcast` is injected rather than imported so this module stays free of
 * transport dependencies and the replay branch is testable with a stub — which
 * is how "`submit` is never reached when a live binding exists" is asserted
 * rather than inferred.
 *
 * NEVER RE-SIGNS: `submit` is invoked only when no live binding was found.
 */
export async function withSendBinding(args: {
  key: string;
  now: () => number;
  rebroadcast: (
    wireHex: string,
    txHashHex: string,
  ) => Promise<{ txHash: string; via: string }>;
  submit: (
    bind: (fields: SendBindingFields) => Promise<void>,
  ) => Promise<SendBindingResult>;
}): Promise<SendBindingResult> {
  const { key, now, rebroadcast, submit } = args;

  const bound = await readSendBinding(key, now());
  if (bound !== null) {
    if (isCompleted(bound)) {
      // Already accepted once. Nothing left to broadcast; answer with the hash
      // the first attempt produced.
      return { txHash: bound.txHashHex, via: bound.via, nonceHex: bound.nonceHex };
    }
    // Signed, outcome unknown. Re-broadcast the IDENTICAL bytes: the chain
    // answers DuplicateKnown / AlreadyConsumed, both counted as acceptance, and
    // the original hash comes back.
    const replay = await rebroadcast(bound.wireHex, bound.txHashHex);
    await completeSendBinding(key, replay.txHash, replay.via, now());
    return { ...replay, nonceHex: bound.nonceHex };
  }

  try {
    const result = await submit(async (fields) => {
      await writeSendBinding(key, { ...fields, via: "", ts: now() });
    });
    // Drop the wire bytes, keep the hash — see completeSendBinding.
    await completeSendBinding(key, result.txHash, result.via, now());
    return result;
  } catch (e) {
    // Nothing was accepted, so the bytes are worthless and the nonce is unspent.
    // Drop the binding so a later attempt signs afresh rather than replaying a
    // transaction the chain never saw.
    await deleteSendBinding(key);
    throw e;
  }
}
