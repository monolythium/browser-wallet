// Golden EIP-712 digest vectors — the refactor safety net for #29.
//
// THE LOAD-BEARING PROPERTY: making the typed-data encoder strict (reject
// instead of silently coerce) must NEVER change a digest a legitimate dApp
// already gets. These vectors pin the digests produced by the CURRENT encoder;
// every one MUST stay byte-identical after the strict-reject change. If any
// digest moves, the strict change altered a legitimate signing flow — STOP.
//
// (a) is the canonical EIP-712 spec "Mail" example; reproducing its published
// digest independently proves the encoder is spec-correct for valid inputs.

import { describe, it, expect } from "vitest";
import { computeTypedDataDigest } from "./typed-data.js";

function hex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function digest(envelope: {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}): string {
  return hex(computeTypedDataDigest(envelope));
}

// ── (a) Canonical EIP-712 "Mail" ────────────────────────────────────────────
// Published spec digest. Anchors the whole suite.
const MAIL_DIGEST =
  "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2";

const MAIL = {
  domain: {
    name: "Ether Mail",
    version: "1",
    chainId: 1,
    verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
  },
  types: {
    Person: [
      { name: "name", type: "string" },
      { name: "wallet", type: "address" },
    ],
    Mail: [
      { name: "from", type: "Person" },
      { name: "to", type: "Person" },
      { name: "contents", type: "string" },
    ],
  },
  primaryType: "Mail",
  message: {
    from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
    contents: "Hello, Bob!",
  },
};

describe("EIP-712 golden vectors — digest invariance", () => {
  it("(a) reproduces the canonical spec Mail digest", () => {
    expect(digest(MAIL)).toBe(MAIL_DIGEST);
  });

  it("(b) address casing is digest-invariant (lowercased == canonical)", () => {
    const lowered = {
      ...MAIL,
      domain: {
        ...MAIL.domain,
        verifyingContract: MAIL.domain.verifyingContract.toLowerCase(),
      },
      message: {
        from: {
          name: "Cow",
          wallet: (MAIL.message.from.wallet as string).toLowerCase(),
        },
        to: {
          name: "Bob",
          wallet: (MAIL.message.to.wallet as string).toLowerCase(),
        },
        contents: "Hello, Bob!",
      },
    };
    // EIP-55 mixed-case and all-lowercase encode the same 20 bytes.
    expect(digest(lowered)).toBe(MAIL_DIGEST);
  });

  it("(c) chainId representation is digest-invariant (number / decimal / hex)", () => {
    const withChain = (chainId: unknown) => ({
      ...MAIL,
      domain: { ...MAIL.domain, chainId },
    });
    expect(digest(withChain(1))).toBe(MAIL_DIGEST); // number
    expect(digest(withChain("1"))).toBe(MAIL_DIGEST); // decimal string
    expect(digest(withChain("0x1"))).toBe(MAIL_DIGEST); // hex string
  });

  it("(d) uint256 representation is digest-invariant (bigint / number / decimal / hex)", () => {
    const u = (x: unknown) => ({
      domain: { name: "D", version: "1" },
      types: { Foo: [{ name: "x", type: "uint256" }] },
      primaryType: "Foo",
      message: { x },
    });
    const dBig = digest(u(1_000_000n));
    expect(digest(u(1_000_000))).toBe(dBig); // number
    expect(digest(u("1000000"))).toBe(dBig); // decimal string
    expect(digest(u("0xf4240"))).toBe(dBig); // hex string
    // Pin the actual value too, so a strict change can't silently move it.
    expect(dBig).toMatchInlineSnapshot(`"0x4ef7f05fa59d26a7a71f4e85e3f440cd607304b7a9c1b48ffad1bb5fca152ade"`);
  });

  it("(e) arrays — dynamic (non-empty + empty) and fixed", () => {
    const arr = (type: string, a: unknown) => ({
      domain: { name: "D", version: "1" },
      types: { Foo: [{ name: "a", type }] },
      primaryType: "Foo",
      message: { a },
    });
    expect(digest(arr("uint256[]", [1n, 2n, 3n]))).toMatchInlineSnapshot(`"0xb3a8e47070a08ea24da6e862e72e62722c4d35d0d6d5695cad8640cf0a988eac"`);
    expect(digest(arr("uint256[]", []))).toMatchInlineSnapshot(`"0xaafaa74df0e43f507452f0054b1a3d5da3eaf4aa6558ed16d6941cf410cdb5e9"`);
    expect(digest(arr("uint256[2]", [1n, 2n]))).toMatchInlineSnapshot(`"0x021b589c35017369638b2249cc37d2f6823a1d34c3ce81d9c2a611a08b01a2ae"`);
  });

  it("(f) bytes — 0x-hex == Uint8Array; bytes32 full word", () => {
    const env = (type: string, v: unknown) => ({
      domain: { name: "D", version: "1" },
      types: { Foo: [{ name: "b", type }] },
      primaryType: "Foo",
      message: { b: v },
    });
    // dynamic bytes: hex string and Uint8Array encode identically.
    const dHex = digest(env("bytes", "0xdeadbeef"));
    expect(digest(env("bytes", new Uint8Array([0xde, 0xad, 0xbe, 0xef])))).toBe(
      dHex,
    );
    expect(dHex).toMatchInlineSnapshot(`"0x11fd575443c652769c2b82f8807e7b606a183ba014120c87ddfa95615405c23d"`);
    expect(digest(env("bytes32", "0x" + "ab".repeat(32)))).toMatchInlineSnapshot(`"0xb42e57545fd5a41351c882838ee2624a38d5add5602bd0bf2d258b0854c87652"`);
  });

  it("(g) bool — true and false (real booleans)", () => {
    const b = (v: boolean) => ({
      domain: { name: "D", version: "1" },
      types: { Foo: [{ name: "ok", type: "bool" }] },
      primaryType: "Foo",
      message: { ok: v },
    });
    const dTrue = digest(b(true));
    const dFalse = digest(b(false));
    expect(dTrue).not.toBe(dFalse);
    expect(dTrue).toMatchInlineSnapshot(`"0xcf7c394f1e848bc13e5c3a88b7f4f9a40e26c9ad403d74472cffaa37d0012fd9"`);
    expect(dFalse).toMatchInlineSnapshot(`"0xc98d21ec33ab1a8202b81a74bf4636985947bcff4f918ca2b80f78a850444b58"`);
  });

  it("(h) domain field subset vs full (domainTypeFor filtering)", () => {
    const base = {
      types: { Foo: [{ name: "x", type: "uint256" }] },
      primaryType: "Foo",
      message: { x: 1n },
    };
    const subset = { ...base, domain: { name: "D", version: "1" } };
    const full = {
      ...base,
      domain: {
        name: "D",
        version: "1",
        chainId: 1,
        verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC",
        salt: "0x" + "11".repeat(32),
      },
    };
    // Different domains → different separators → different digests.
    expect(digest(subset)).not.toBe(digest(full));
    expect(digest(subset)).toMatchInlineSnapshot(`"0xd0fbb23c51983503dbae4e26035e21f5adbd8e8a6cb02630d8f6a2f268b6017a"`);
    expect(digest(full)).toMatchInlineSnapshot(`"0x0650601aa8e081fe6245f22974bb14775ab09da59fa210803f2af40c9d919664"`);
  });
});
