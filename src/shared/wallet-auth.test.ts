import { describe, expect, it } from "vitest";
import {
  addressToTypedBech32,
  verifyWalletAuthProofV1,
} from "@monolythium/core-sdk";
import { MlDsa65Backend } from "@monolythium/core-sdk/crypto";
import {
  WALLET_AUTH_SIGNING_PREFIX,
  WalletAuthRequestError,
  buildWalletAuthChallengeV1,
  bytesToLowerHex,
  canonicalWalletAuthChallengeJsonV1,
  encodeWalletAuthChallengeV1,
  parseWalletAuthRequestV1,
  walletAuthChallengeDigestV1,
  walletAuthChallengeSigningPreimageV1,
} from "./wallet-auth.js";

const ORIGIN = "https://stele.monolythium.com";
const GENESIS = `0x${"ab".repeat(32)}`;
const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const NONCE = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const ADDRESS = "mono1qypfsc5yp538a608d2z9er9mszap6lfrl3sc46";
const MAX_UINT256_DECIMAL =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";

function validRequest(): Record<string, unknown> {
  return {
    version: "1",
    domain: "stele.monolythium.com",
    origin: ORIGIN,
    uri: `${ORIGIN}/`,
    chainId: "69420",
    genesisHash: GENESIS,
    nonce: NONCE,
    issuedAt: "2026-07-16T11:59:30.000Z",
    expirationTime: "2026-07-16T12:01:30.000Z",
    scopes: ["stele:web:session"],
  };
}

function parse(input: unknown, nowMs = NOW) {
  return parseWalletAuthRequestV1(input, {
    origin: ORIGIN,
    chainId: "69420",
    genesisHash: GENESIS,
    nowMs,
  });
}

describe("wallet authentication v1 request validation", () => {
  it("accepts an exact origin/network-bound request and keeps scopes unchanged", () => {
    expect(parse(validRequest())).toEqual(validRequest());
  });

  it.each([
    ["address injection", { address: ADDRESS }],
    ["unknown field", { statement: "sign this" }],
  ])("rejects %s", (_label, extra) => {
    expect(() => parse({ ...validRequest(), ...extra })).toThrow(/not allowed/);
  });

  it("stops inspecting own fields as soon as the bounded allowance is exhausted", () => {
    const oversized: Record<string, unknown> = { ...validRequest() };
    for (let index = 0; index < 1_000; index += 1) {
      oversized[`extra${index}`] = index;
    }
    let ownPropertyChecks = 0;
    const instrumented = new Proxy(oversized, {
      getOwnPropertyDescriptor(target, property) {
        ownPropertyChecks += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });

    expect(() => parse(instrumented)).toThrow(/not allowed|too many fields/);
    expect(ownPropertyChecks).toBeLessThan(100);
  });

  it.each([
    ["origin", { origin: "https://evil.example" }],
    ["domain", { domain: "evil.example" }],
    ["URI", { uri: "https://stele.monolythium.com/login" }],
    ["chain", { chainId: "1" }],
    ["genesis", { genesisHash: `0x${"cd".repeat(32)}` }],
  ])("rejects a wrong %s binding", (_label, patch) => {
    expect(() => parse({ ...validRequest(), ...patch })).toThrow(/does not match/);
  });

  it.each([
    ["non-decimal chain", { chainId: "0x10F2C" }],
    ["leading-zero chain", { chainId: "069420" }],
    ["uppercase genesis", { genesisHash: `0x${"AB".repeat(32)}` }],
    ["padded nonce", { nonce: `${NONCE}=` }],
    ["short nonce", { nonce: NONCE.slice(1) }],
    ["noncanonical time", { issuedAt: "2026-07-16T11:59:30Z" }],
    ["duplicate scopes", { scopes: ["stele:web:session", "stele:web:session"] }],
    ["unsorted scopes", { scopes: ["zeta:web:session", "alpha:web:session"] }],
    ["non-ASCII scope", { scopes: ["stèle:web:session"] }],
  ])("rejects %s", (_label, patch) => {
    expect(() => parse({ ...validRequest(), ...patch })).toThrow(WalletAuthRequestError);
  });

  it.each([
    ["version", { version: "1".repeat(9) }],
    ["domain", { domain: "a".repeat(513) }],
    ["origin", { origin: `https://${"a".repeat(521)}` }],
    ["URI", { uri: `${ORIGIN}/${"a".repeat(500)}` }],
    ["chainId", { chainId: "1".repeat(79) }],
    ["genesisHash", { genesisHash: `0x${"a".repeat(65)}` }],
    ["nonce", { nonce: "A".repeat(44) }],
    ["issuedAt", { issuedAt: "2".repeat(25) }],
    ["scope", { scopes: ["a".repeat(129)] }],
  ])("caps oversized %s before its parser or regex", (_label, patch) => {
    expect(() => parse({ ...validRequest(), ...patch })).toThrow(/maximum length/);
  });

  it("accepts uint256 max and rejects the next same-length decimal lexically", () => {
    const maxRequest = { ...validRequest(), chainId: MAX_UINT256_DECIMAL };
    expect(
      parseWalletAuthRequestV1(maxRequest, {
        origin: ORIGIN,
        chainId: MAX_UINT256_DECIMAL,
        genesisHash: GENESIS,
        nowMs: NOW,
      }).chainId,
    ).toBe(MAX_UINT256_DECIMAL);

    const overMax = `${MAX_UINT256_DECIMAL.slice(0, -1)}6`;
    expect(() =>
      parseWalletAuthRequestV1(
        { ...validRequest(), chainId: overMax },
        {
          origin: ORIGIN,
          chainId: overMax,
          genesisHash: GENESIS,
          nowMs: NOW,
        },
      ),
    ).toThrow(/uint256/);
  });

  it("enforces positive lifetime no longer than 180 seconds", () => {
    expect(() =>
      parse({
        ...validRequest(),
        issuedAt: "2026-07-16T11:59:00.000Z",
        expirationTime: "2026-07-16T12:02:00.001Z",
      }),
    ).toThrow(/at most 180 seconds/);
    expect(() =>
      parse({
        ...validRequest(),
        issuedAt: "2026-07-16T12:00:00.000Z",
        expirationTime: "2026-07-16T12:00:00.000Z",
      }),
    ).toThrow(/greater than 0/);
  });

  it("rejects expired and excessively future-issued challenges", () => {
    expect(() => parse(validRequest(), Date.parse("2026-07-16T12:01:30.000Z"))).toThrow(
      /expired/,
    );
    expect(() =>
      parse(
        {
          ...validRequest(),
          issuedAt: "2026-07-16T12:00:30.001Z",
          expirationTime: "2026-07-16T12:01:30.001Z",
        },
        NOW,
      ),
    ).toThrow(/future/);
  });
});

describe("wallet authentication v1 canonical signing bytes", () => {
  it("inserts the wallet address in the locked field order", () => {
    const challenge = buildWalletAuthChallengeV1(parse(validRequest()), ADDRESS);
    const json = canonicalWalletAuthChallengeJsonV1(challenge);
    expect(json).toBe(
      `{"version":"1","domain":"stele.monolythium.com","origin":"https://stele.monolythium.com","uri":"https://stele.monolythium.com/","address":"${ADDRESS}","chainId":"69420","genesisHash":"${GENESIS}","nonce":"${NONCE}","issuedAt":"2026-07-16T11:59:30.000Z","expirationTime":"2026-07-16T12:01:30.000Z","scopes":["stele:web:session"]}`,
    );
    expect(new TextDecoder().decode(walletAuthChallengeSigningPreimageV1(challenge))).toBe(
      WALLET_AUTH_SIGNING_PREFIX + json,
    );
    expect(new TextDecoder().decode(encodeWalletAuthChallengeV1(challenge))).toBe(json);
    expect(walletAuthChallengeDigestV1(challenge)).toHaveLength(32);
  });

  it("rejects a non-typed or malformed signer address", () => {
    expect(() => buildWalletAuthChallengeV1(parse(validRequest()), `0x${"12".repeat(20)}`)).toThrow(
      /typed mono1/,
    );
    expect(() =>
      buildWalletAuthChallengeV1(parse(validRequest()), "a".repeat(129)),
    ).toThrow(/maximum length/);
  });

  it("matches the generic SDK golden canonical digest", () => {
    const origin = "https://stele.example:8443";
    const request = parseWalletAuthRequestV1(
      {
        version: "1",
        domain: "stele.example:8443",
        origin,
        uri: `${origin}/`,
        chainId: "1337",
        genesisHash: GENESIS,
        nonce: "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo",
        issuedAt: "2030-01-02T03:04:05.006Z",
        expirationTime: "2030-01-02T03:07:05.006Z",
        scopes: ["booking:write", "services:read", "stele:web:session"],
      },
      {
        origin,
        chainId: "1337",
        genesisHash: GENESIS,
        nowMs: Date.parse("2030-01-02T03:05:00.000Z"),
      },
    );
    const challenge = buildWalletAuthChallengeV1(
      request,
      "mono1dytvzzug96qtr0k09em5qm95hqn83cdyag8k3u",
    );
    expect(bytesToLowerHex(walletAuthChallengeDigestV1(challenge))).toBe(
      "0x3f303dca413a7aadee6fb77d06b7aa69727fc602e77ee1b63247ddf5429ec934",
    );
  });

  it("produces a deterministic real proof the published SDK verifier accepts", () => {
    const backend = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(0x5a));
    try {
      const publicKey = backend.publicKey();
      const address = addressToTypedBech32("user", backend.getAddress());
      const challenge = buildWalletAuthChallengeV1(parse(validRequest()), address);
      const digest = walletAuthChallengeDigestV1(challenge);
      const signature = backend.signPrehash(digest);
      const proof = {
        challenge,
        algorithm: "ml-dsa-65" as const,
        publicKey: bytesToLowerHex(publicKey),
        signature: bytesToLowerHex(signature),
      };

      expect(publicKey).toHaveLength(1952);
      expect(signature).toHaveLength(3309);
      expect(verifyWalletAuthProofV1(proof, { now: NOW })).toEqual(proof);

      expect(() =>
        verifyWalletAuthProofV1(
          {
            ...proof,
            challenge: {
              ...challenge,
              scopes: ["stele:web:tampered"],
            },
          },
          { now: NOW },
        ),
      ).toThrow(/signature/i);
    } finally {
      backend.dispose();
    }
  });
});
