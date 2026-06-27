// WebAuthn assertion verification — Option A, boundary 3a (the standalone
// crypto utility).
//
// PURE + ISOLATED: this function only verifies a forwarded WebAuthn assertion.
// It does NOT mint challenges, read storage, or touch the sign path — commit 3b
// wires it (challenge mint + tx-intent binding + the popup forward + the
// `passkey-ok` branch + the pubkey-less re-register route).
//
// Uses `crypto.subtle` (available in the MV3 service worker). Supports EXACTLY
// the two algs the wallet registers (`PasskeyRegisterModal` pubKeyCredParams):
// ES256 (`-7`) and RS256 (`-257`). Any other stored alg is rejected.
//
// The assertion is verified fail-closed: ANY failed check returns
// `{ ok: false }` — no partial trust. On success it returns the asserted
// signature counter so the caller can persist the monotonic advance.

const COSE_ES256 = -7;
const COSE_RS256 = -257;
const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified

/** The stored credential fields needed to verify (a subset of
 *  `PasskeyCredential`). A credential persisted before Part-1a has no
 *  `publicKeySpki`/`alg` → `verifyPasskeyAssertion` returns
 *  `{ ok:false, reason:"no-pubkey" }` so the caller routes to re-register. */
export interface StoredCredentialForVerify {
  /** base64url(SPKI DER) captured at registration. */
  publicKeySpki?: string;
  /** COSE alg id: -7 (ES256) or -257 (RS256). */
  alg?: number;
  /** Last-seen signature counter. */
  signCount?: number;
}

/** The (already base64url-decoded) assertion the popup forwards. */
export interface PasskeyAssertionInput {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  credentialId: string;
}

export interface VerifyPasskeyArgs {
  assertion: PasskeyAssertionInput;
  /** The exact challenge bytes the SW issued (single-use, tx-bound). */
  expectedChallenge: Uint8Array;
  /** The wallet's extension origin, e.g. `chrome-extension://<id>`. */
  expectedOrigin: string;
  /** The registered rpId (the extension host id, since `rp.id` is omitted). */
  expectedRpId: string;
  credential: StoredCredentialForVerify;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  /** The asserted signature counter, returned only on success so the caller
   *  can persist the monotonic advance. */
  newSignCount?: number;
}

/** Verify a forwarded WebAuthn assertion against a stored credential. All
 *  checks must pass; any failure returns `{ ok:false, reason }`. */
export async function verifyPasskeyAssertion(
  args: VerifyPasskeyArgs,
): Promise<VerifyResult> {
  const { assertion, expectedChallenge, expectedOrigin, expectedRpId, credential } =
    args;

  // (5, early) A credential with no stored pubkey/alg cannot be verified — the
  // caller must route the user to re-register.
  if (
    typeof credential.publicKeySpki !== "string" ||
    credential.publicKeySpki.length === 0 ||
    typeof credential.alg !== "number"
  ) {
    return { ok: false, reason: "no-pubkey" };
  }
  if (credential.alg !== COSE_ES256 && credential.alg !== COSE_RS256) {
    return { ok: false, reason: "unsupported-alg" };
  }

  // (1) clientDataJSON parses + is a get assertion.
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    clientData = JSON.parse(new TextDecoder().decode(assertion.clientDataJSON));
  } catch {
    return { ok: false, reason: "bad-clientdata-json" };
  }
  if (clientData.type !== "webauthn.get") {
    return { ok: false, reason: "bad-type" };
  }

  // (2) The challenge decodes EQUAL to the bytes the SW issued.
  if (typeof clientData.challenge !== "string") {
    return { ok: false, reason: "bad-challenge" };
  }
  const assertedChallenge = base64UrlToBytes(clientData.challenge);
  if (
    assertedChallenge === null ||
    !bytesEqual(assertedChallenge, expectedChallenge)
  ) {
    return { ok: false, reason: "challenge-mismatch" };
  }

  // (3) Origin is the wallet's.
  if (clientData.origin !== expectedOrigin) {
    return { ok: false, reason: "origin-mismatch" };
  }

  // (4) authenticatorData: rpIdHash, UV+UP flags, signCount.
  const ad = assertion.authenticatorData;
  if (ad.length < 37) {
    return { ok: false, reason: "bad-authdata" };
  }
  const rpIdHash = ad.subarray(0, 32);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedRpId)),
  );
  if (!bytesEqual(rpIdHash, expectedRpIdHash)) {
    return { ok: false, reason: "rpid-mismatch" };
  }
  const flags = ad[32]!;
  if ((flags & FLAG_UV) === 0) return { ok: false, reason: "uv-not-set" };
  if ((flags & FLAG_UP) === 0) return { ok: false, reason: "up-not-set" };
  const assertedSignCount = new DataView(
    ad.buffer,
    ad.byteOffset,
    ad.byteLength,
  ).getUint32(33, false);

  // (6) Signature over `authenticatorData || SHA-256(clientDataJSON)`.
  const clientDataHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(assertion.clientDataJSON)),
  );
  const signedData = concatBytes(ad, clientDataHash);
  const spki = base64UrlToBytes(credential.publicKeySpki);
  if (spki === null) return { ok: false, reason: "bad-spki" };

  let verified: boolean;
  try {
    if (credential.alg === COSE_ES256) {
      const key = await crypto.subtle.importKey(
        "spki",
        toArrayBuffer(spki),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      // WebAuthn ES256 signatures are ASN.1 DER; crypto.subtle wants raw r||s.
      const sigRaw = derToRawEcdsaSig(assertion.signature);
      verified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        toArrayBuffer(sigRaw),
        toArrayBuffer(signedData),
      );
    } else {
      const key = await crypto.subtle.importKey(
        "spki",
        toArrayBuffer(spki),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      // RS256 signature is raw PKCS#1 v1.5 — no conversion.
      verified = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        toArrayBuffer(assertion.signature),
        toArrayBuffer(signedData),
      );
    }
  } catch {
    return { ok: false, reason: "verify-error" };
  }
  if (!verified) return { ok: false, reason: "bad-signature" };

  // (7) signCount monotonic — exempt the all-zero case (many platform
  // authenticators always report 0).
  const stored = credential.signCount ?? 0;
  if ((stored > 0 || assertedSignCount > 0) && assertedSignCount <= stored) {
    return { ok: false, reason: "signcount-regression" };
  }

  return { ok: true, newSignCount: assertedSignCount };
}

// ────────────────────────────────────────────────────────────────────────────
// ECDSA DER → raw (IEEE P1363) — the only bespoke parsing; it must be correct.
// ────────────────────────────────────────────────────────────────────────────

/** Convert a WebAuthn ES256 signature (ASN.1 DER `SEQUENCE(INTEGER r, INTEGER
 *  s)`) to the 64-byte raw `r||s` form `crypto.subtle` ECDSA expects. Strips a
 *  leading sign byte from each integer and left-pads to 32 bytes. THROWS on
 *  malformed DER (the caller treats a throw as a verify failure). Short-form
 *  lengths only — a P-256 signature is always < 128 bytes. */
export function derToRawEcdsaSig(der: Uint8Array): Uint8Array {
  if (der.length < 8) throw new Error("bad DER: too short");
  if (der[0] !== 0x30) throw new Error("bad DER: not a SEQUENCE");
  let o = 1;
  const seqLen = der[o++]!;
  if (seqLen & 0x80) throw new Error("bad DER: long-form sequence length");
  if (o + seqLen !== der.length) throw new Error("bad DER: sequence length mismatch");

  // INTEGER r
  if (der[o++] !== 0x02) throw new Error("bad DER: r is not an INTEGER");
  const rLen = der[o++]!;
  if (rLen === 0 || rLen & 0x80) throw new Error("bad DER: bad r length");
  if (o + rLen > der.length) throw new Error("bad DER: r overruns");
  const r = der.subarray(o, o + rLen);
  o += rLen;

  // INTEGER s
  if (der[o++] !== 0x02) throw new Error("bad DER: s is not an INTEGER");
  const sLen = der[o++]!;
  if (sLen === 0 || sLen & 0x80) throw new Error("bad DER: bad s length");
  if (o + sLen > der.length) throw new Error("bad DER: s overruns");
  const s = der.subarray(o, o + sLen);
  o += sLen;

  if (o !== der.length) throw new Error("bad DER: trailing bytes");

  const out = new Uint8Array(64);
  out.set(leftPad32(stripLeadingZeros(r)), 0);
  out.set(leftPad32(stripLeadingZeros(s)), 32);
  return out;
}

function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00) i++;
  return b.subarray(i);
}

function leftPad32(b: Uint8Array): Uint8Array {
  if (b.length > 32) throw new Error("bad DER: integer too long for P-256");
  if (b.length === 32) return b;
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// byte helpers
// ────────────────────────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A fresh ArrayBuffer-backed copy so the value satisfies the WebCrypto
 *  `BufferSource` type (rejecting `SharedArrayBuffer`-backed views) regardless
 *  of how the input Uint8Array was sliced. */
function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(b.length);
  new Uint8Array(buf).set(b);
  return buf;
}

function base64UrlToBytes(s: string): Uint8Array | null {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
