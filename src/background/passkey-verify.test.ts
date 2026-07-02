// passkey-verify — the security-critical WebAuthn assertion verifier.
//
// These tests CONSTRUCT REAL assertions with `crypto.subtle` (generate a key,
// build authData + clientDataJSON exactly as an authenticator does, sign, and
// — for ES256 — DER-encode the signature like a real authenticator) so the
// verifier and its DER→raw conversion are exercised end-to-end, not mocked.

import { describe, it, expect } from "vitest";
import { verifyPasskeyAssertion, derToRawEcdsaSig } from "./passkey-verify.js";

const enc = new TextEncoder();
const RP_ID = "abcdefghijklmnopabcdefghijklmnop"; // a fake extension host id
const ORIGIN = `chrome-extension://${RP_ID}`;

function b64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
/** Fresh ArrayBuffer-backed copy so the value satisfies the WebCrypto
 *  `BufferSource` type (the DOM lib rejects `ArrayBufferLike`-backed views). */
function toBuf(b: Uint8Array): ArrayBuffer {
  const a = new ArrayBuffer(b.length);
  new Uint8Array(a).set(b);
  return a;
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toBuf(b)));
}
async function buildAuthData(
  rpId: string,
  flags: number,
  signCount: number,
): Promise<Uint8Array> {
  const rpIdHash = await sha256(enc.encode(rpId));
  const sc = new Uint8Array(4);
  new DataView(sc.buffer).setUint32(0, signCount, false);
  return concat(rpIdHash, new Uint8Array([flags]), sc);
}
function buildClientData(challenge: Uint8Array, origin: string): Uint8Array {
  return enc.encode(
    JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin }),
  );
}
/** Encode a raw r||s (64 bytes, IEEE-P1363) signature as the ASN.1 DER a real
 *  authenticator emits — minimal integers, 0x00 sign byte when the MSB is set. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const derInt = (b: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0x00) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0x00]), v);
    return v;
  };
  const r = derInt(raw.subarray(0, 32));
  const s = derInt(raw.subarray(32, 64));
  const body = concat(
    new Uint8Array([0x02, r.length]),
    r,
    new Uint8Array([0x02, s.length]),
    s,
  );
  return concat(new Uint8Array([0x30, body.length]), body);
}

const UP_UV = 0x05; // user-present + user-verified

async function makeEs256() {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  return { kp, spki: b64url(spki) };
}

/** Build a fully-valid ES256 assertion + verify args, with optional tweaks. */
async function validEs256(opts?: {
  flags?: number;
  signCount?: number;
  storedSignCount?: number;
}) {
  const { kp, spki } = await makeEs256();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const authData = await buildAuthData(
    RP_ID,
    opts?.flags ?? UP_UV,
    opts?.signCount ?? 7,
  );
  const clientDataJSON = buildClientData(challenge, ORIGIN);
  const signedData = concat(authData, await sha256(clientDataJSON));
  const rawSig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      kp.privateKey,
      toBuf(signedData),
    ),
  );
  const signature = rawToDer(rawSig); // authenticators emit DER
  return {
    args: {
      assertion: { authenticatorData: authData, clientDataJSON, signature, credentialId: "c" },
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      credential: {
        publicKeySpki: spki,
        alg: -7,
        signCount: opts?.storedSignCount ?? 0,
      },
    },
    authData,
    clientDataJSON,
    signature,
    challenge,
  };
}

describe("verifyPasskeyAssertion — ES256", () => {
  it("verifies a valid assertion and returns the asserted signCount", async () => {
    const { args } = await validEs256({ signCount: 7 });
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(true);
    expect(r.newSignCount).toBe(7);
  });

  it("rejects a wrong challenge", async () => {
    const { args } = await validEs256();
    args.expectedChallenge = crypto.getRandomValues(new Uint8Array(32));
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("challenge-mismatch");
  });

  it("rejects a wrong origin", async () => {
    const { args } = await validEs256();
    args.expectedOrigin = "chrome-extension://someoneelses";
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("origin-mismatch");
  });

  it("rejects a wrong rpId (rpIdHash mismatch)", async () => {
    const { args } = await validEs256();
    args.expectedRpId = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rpid-mismatch");
  });

  it("rejects UV cleared (flags = UP only)", async () => {
    const { args } = await validEs256({ flags: 0x01 });
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("uv-not-set");
  });

  it("rejects a flipped signature byte", async () => {
    const { args, signature } = await validEs256();
    const last = signature.length - 1;
    signature[last] = (signature[last] ?? 0) ^ 0xff; // corrupt s, DER stays well-formed
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    // a flipped value byte → bad-signature; a flipped structural byte → verify-error.
    expect(["bad-signature", "verify-error"]).toContain(r.reason);
  });

  it("rejects tampered authData (signature no longer matches)", async () => {
    const { args, authData } = await validEs256();
    authData[36] = (authData[36] ?? 0) ^ 0x0f; // flip a signCount byte — rpIdHash + flags stay valid
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("bad-signature");
  });

  it("rejects a signCount regression (stored 10, asserted 5)", async () => {
    const { args } = await validEs256({ signCount: 5, storedSignCount: 10 });
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("signcount-regression");
  });

  it("exempts the all-zero signCount case", async () => {
    const { args } = await validEs256({ signCount: 0, storedSignCount: 0 });
    const r = await verifyPasskeyAssertion(args);
    expect(r.ok).toBe(true);
    expect(r.newSignCount).toBe(0);
  });

  it("rejects a stored credential with NO pubkey (reason no-pubkey)", async () => {
    const { args } = await validEs256();
    const r = await verifyPasskeyAssertion({
      ...args,
      credential: { signCount: 0 }, // legacy / pubkey-less
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no-pubkey");
  });

  it("rejects an unsupported stored alg", async () => {
    const { args } = await validEs256();
    const r = await verifyPasskeyAssertion({
      ...args,
      credential: { ...args.credential, alg: -8 }, // EdDSA — not registered
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported-alg");
  });
});

describe("verifyPasskeyAssertion — RS256 (no DER conversion)", () => {
  it("verifies a valid RSASSA-PKCS1-v1_5 assertion", async () => {
    const kp = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = b64url(
      new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)),
    );
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const authData = await buildAuthData(RP_ID, UP_UV, 3);
    const clientDataJSON = buildClientData(challenge, ORIGIN);
    const signedData = concat(authData, await sha256(clientDataJSON));
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, toBuf(signedData)),
    );
    const r = await verifyPasskeyAssertion({
      assertion: { authenticatorData: authData, clientDataJSON, signature, credentialId: "c" },
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRpId: RP_ID,
      credential: { publicKeySpki: spki, alg: -257, signCount: 0 },
    });
    expect(r.ok).toBe(true);
    expect(r.newSignCount).toBe(3);
  });
});

describe("derToRawEcdsaSig", () => {
  it("pads short / leading-zero r and s to 32 bytes", () => {
    const r = new Uint8Array([0x01]); // value 1
    // s = 0x00 sign byte + 32-byte value whose MSB is set (0x80 …) = 33 bytes.
    const s = concat(new Uint8Array([0x00, 0x80]), new Uint8Array(31).fill(0x11));
    const body = concat(
      new Uint8Array([0x02, r.length]),
      r,
      new Uint8Array([0x02, s.length]),
      s,
    );
    const der = concat(new Uint8Array([0x30, body.length]), body);
    const raw = derToRawEcdsaSig(der);
    expect(raw.length).toBe(64);
    // r left-padded into the first 32 bytes.
    expect(raw[31]).toBe(0x01);
    expect(raw.subarray(0, 31).every((x) => x === 0)).toBe(true);
    // s: the 0x00 sign byte stripped → 32-byte value starting 0x80, 0x11…
    expect(raw[32]).toBe(0x80);
    expect(raw[33]).toBe(0x11);
  });

  it("rejects malformed DER", () => {
    // not a SEQUENCE (0x31), but long enough to pass the length check first.
    expect(() =>
      derToRawEcdsaSig(new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])),
    ).toThrow();
    // too short overall.
    expect(() =>
      derToRawEcdsaSig(new Uint8Array([0x30, 0x02, 0x02, 0x01, 0x01])),
    ).toThrow();
    // sequence-length mismatch.
    expect(() =>
      derToRawEcdsaSig(new Uint8Array([0x30, 0x20, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01])),
    ).toThrow();
  });
});
