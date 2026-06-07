// Pure-helper tests for the SLH-DSA backup data
// model. No `@noble/post-quantum`, no `chrome.storage`, no IPC — those
// land in separate tests. This file pins the shape contract +
// storage-round-trip resilience that downstream commits will depend on.

import { describe, expect, it } from "vitest";
import {
  EMERGENCY_KEY_PRECOMPILE_ADDRESS,
  SLH_DSA_SHA2_128S_ALGO_ID,
  SLH_DSA_SHA2_128S_LENGTHS,
  backupStatusLabel,
  cloneBackupForRead,
  cloneBackupForWrite,
  decodeBackupPublicKeyHex,
  emptySlhDsaBackup,
  hasBackupStarted,
  isBackupComplete,
  validateBackupShape,
  type SlhDsaBackup,
} from "./slh-dsa-backup.js";

/** Build a syntactically-valid backup record for the targeted status.
 *  No actual cryptography — the strings are dummy fixtures of the
 *  right shape (64 hex chars for the 32-byte pubkey, non-empty
 *  base64 for the encrypted secret + nonce). */
function fakeBackup(overrides: Partial<SlhDsaBackup> = {}): SlhDsaBackup {
  return {
    encryptedPrivateKey: "dGVzdC1lbmNyeXB0ZWQ=",
    encryptedPrivateKeyNonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
    encryptedEntropy: "ZW50cm9weS1lbmNyeXB0ZWQ=",
    encryptedEntropyNonce: "GBkaGxwdHh8gISIjJCUmJygpKisscy0u",
    // 32 bytes (64 hex chars) of fake pubkey material.
    publicKey: "ab".repeat(32),
    parameterSet: "slh_dsa_sha2_128s",
    chainRegistrationStatus: "not-registered",
    coldStorageConfirmed: false,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe("chain-side constants", () => {
  it("pins the emergency-key precompile to 0x1100", () => {
    expect(EMERGENCY_KEY_PRECOMPILE_ADDRESS).toBe(
      "0x0000000000000000000000000000000000001100",
    );
  });

  it("pins the SLH-DSA-SHA2-128s algo id to 1101", () => {
    // Sourced from mono-core's `StandardAlgo::SlhDsaSha2_128s = 1101`
    // — a wallet-side drift would silently break chain registration.
    expect(SLH_DSA_SHA2_128S_ALGO_ID).toBe(1101);
  });

  it("pins the chain-validated pubkey length to 32 bytes", () => {
    // Sourced from FIPS 205 + verified against `@noble/post-quantum
    // @0.6.1`. The chain's `validate.rs::WrongPubkeyLength` arm
    // checks exactly this byte length.
    expect(SLH_DSA_SHA2_128S_LENGTHS.publicKey).toBe(32);
  });

  it("pins the keygen seed length to 48 bytes (FIPS 205 n=16, 3n)", () => {
    expect(SLH_DSA_SHA2_128S_LENGTHS.seed).toBe(48);
  });

  it("pins the secret-key length to 64 bytes", () => {
    expect(SLH_DSA_SHA2_128S_LENGTHS.secretKey).toBe(64);
  });

  it("pins the full FIPS-205 length table (128s sig = 7856, not 128f = 17088)", () => {
    // SLH-DSA-SHA2-128s per FIPS-205 (Table 8) / RFC 9909
    // (`id-slh-dsa-sha2-128s`). The 's' (small-signature) variant's
    // signature is 7856 bytes; 17088 is the 128*f* (fast) value and
    // must never be transcribed here. Locks the WHOLE table so neither
    // the signature size nor any other field can silently regress.
    expect(SLH_DSA_SHA2_128S_LENGTHS).toEqual({
      publicKey: 32,
      secretKey: 64,
      signature: 7856,
      seed: 48,
      signRand: 16,
    });
  });
});

describe("emptySlhDsaBackup", () => {
  it("returns a placeholder shape with empty pubkey + createdAt=0", () => {
    const e = emptySlhDsaBackup();
    expect(e.publicKey).toBe("");
    expect(e.createdAt).toBe(0);
    expect(e.chainRegistrationStatus).toBe("not-registered");
    expect(e.coldStorageConfirmed).toBe(false);
  });

  it("the placeholder validates cleanly", () => {
    // createdAt === 0 is the documented escape hatch for the
    // empty-pubkey-allowed branch of validateBackupShape.
    expect(validateBackupShape(emptySlhDsaBackup())).toBeNull();
  });
});

describe("validateBackupShape", () => {
  it("accepts a well-formed record", () => {
    expect(validateBackupShape(fakeBackup())).toBeNull();
  });

  it("rejects null / non-object", () => {
    expect(validateBackupShape(null)).toBe("missing-fields");
    expect(validateBackupShape(undefined)).toBe("missing-fields");
    expect(validateBackupShape("nope")).toBe("missing-fields");
    expect(validateBackupShape(42)).toBe("missing-fields");
  });

  it("rejects missing required fields", () => {
    const r = fakeBackup() as unknown as Record<string, unknown>;
    delete r.publicKey;
    expect(validateBackupShape(r)).toBe("missing-fields");
  });

  it("rejects unknown parameter sets", () => {
    expect(
      validateBackupShape(
        fakeBackup({
          parameterSet: "slh_dsa_shake_256s" as unknown as "slh_dsa_sha2_128s",
        }),
      ),
    ).toBe("bad-parameter-set");
  });

  it("rejects a non-32-byte pubkey", () => {
    expect(
      validateBackupShape(fakeBackup({ publicKey: "ab".repeat(16) })),
    ).toBe("bad-public-key-length");
  });

  it("rejects non-hex pubkey characters", () => {
    expect(
      validateBackupShape(
        fakeBackup({ publicKey: "g".repeat(64) }),
      ),
    ).toBe("bad-public-key-hex");
  });

  it("rejects an unknown chainRegistrationStatus value", () => {
    expect(
      validateBackupShape(
        fakeBackup({
          chainRegistrationStatus:
            "rotated" as unknown as "not-registered",
        }),
      ),
    ).toBe("bad-status");
  });

  it("rejects a non-number createdAt", () => {
    const r = fakeBackup() as unknown as Record<string, unknown>;
    r.createdAt = "1700000000000";
    expect(validateBackupShape(r)).toBe("bad-createdAt");
  });

  it("allows an empty pubkey ONLY on the createdAt=0 placeholder", () => {
    // The empty placeholder is fine.
    expect(
      validateBackupShape(fakeBackup({ publicKey: "", createdAt: 0 })),
    ).toBeNull();
    // A real record with empty pubkey is corruption.
    expect(
      validateBackupShape(
        fakeBackup({ publicKey: "", createdAt: 1_700_000_000_000 }),
      ),
    ).toBe("bad-public-key-length");
  });
});

describe("cloneBackupForRead", () => {
  it("returns null for missing / null / non-object input", () => {
    expect(cloneBackupForRead(null)).toBeNull();
    expect(cloneBackupForRead(undefined)).toBeNull();
    expect(cloneBackupForRead("garbage")).toBeNull();
    expect(cloneBackupForRead(42)).toBeNull();
  });

  it("returns null for a corrupt record (so the read path heals)", () => {
    // Mirrors the heal-on-corrupt-record discipline — a bad on-disk record
    // shouldn't crash the IPC, just present as "not configured".
    expect(
      cloneBackupForRead(fakeBackup({ publicKey: "g".repeat(64) })),
    ).toBeNull();
  });

  it("round-trips a well-formed record cleanly", () => {
    const original = fakeBackup({
      chainRegistrationStatus: "registered",
      chainRegistrationTxHash:
        "0x1234567890123456789012345678901234567890123456789012345678901234",
      chainRegistrationBlock: 100_000,
      coldStorageConfirmed: true,
    });
    const cloned = cloneBackupForRead(original);
    expect(cloned).not.toBeNull();
    expect(cloned).toEqual(original);
  });

  it("strips unknown fields (defence-in-depth)", () => {
    const tainted = {
      ...fakeBackup(),
      randomGarbage: "should not survive",
      anotherField: { nested: true },
    };
    const cloned = cloneBackupForRead(tainted);
    expect(cloned).not.toBeNull();
    expect(
      (cloned as unknown as Record<string, unknown>).randomGarbage,
    ).toBeUndefined();
    expect(
      (cloned as unknown as Record<string, unknown>).anotherField,
    ).toBeUndefined();
  });

  it("omits optional fields when input has wrong types", () => {
    // chainRegistrationBlock arrives as a string from a malformed
    // round-trip → the clone drops it rather than coerce.
    const cloned = cloneBackupForRead({
      ...fakeBackup(),
      chainRegistrationBlock: "100" as unknown as number,
    });
    expect(cloned?.chainRegistrationBlock).toBeUndefined();
  });
});

describe("cloneBackupForWrite", () => {
  it("preserves every field of a fully-populated record", () => {
    const b = fakeBackup({
      chainRegistrationStatus: "registered",
      chainRegistrationTxHash: "0x" + "a".repeat(64),
      chainRegistrationBlock: 42,
      coldStorageConfirmed: true,
    });
    const w = cloneBackupForWrite(b);
    expect(w).toEqual(b);
  });

  it("omits undefined optional fields (exactOptionalPropertyTypes safe)", () => {
    const b = fakeBackup();
    const w = cloneBackupForWrite(b);
    expect("chainRegistrationTxHash" in w).toBe(false);
    expect("chainRegistrationBlock" in w).toBe(false);
    expect("chainRegistrationError" in w).toBe(false);
  });

  it("includes optional fields when present", () => {
    const b = fakeBackup({
      chainRegistrationError: "AlreadyRegistered",
      chainRegistrationStatus: "registration-failed",
    });
    const w = cloneBackupForWrite(b);
    expect(w.chainRegistrationError).toBe("AlreadyRegistered");
  });
});

describe("backupStatusLabel", () => {
  it("'Not set up' for absent / empty placeholder", () => {
    expect(backupStatusLabel(null)).toBe("Not set up");
    expect(backupStatusLabel(undefined)).toBe("Not set up");
    expect(backupStatusLabel(emptySlhDsaBackup())).toBe("Not set up");
  });

  it("distinguishes confirmed vs unconfirmed cold storage", () => {
    expect(
      backupStatusLabel(fakeBackup({ coldStorageConfirmed: false })),
    ).toBe("Locally generated (backup not confirmed)");
    expect(
      backupStatusLabel(fakeBackup({ coldStorageConfirmed: true })),
    ).toBe("Locally generated (not on chain)");
  });

  it("'Registering on chain…' during pending", () => {
    expect(
      backupStatusLabel(
        fakeBackup({
          chainRegistrationStatus: "pending",
          coldStorageConfirmed: true,
        }),
      ),
    ).toBe("Registering on chain…");
  });

  it("'Chain registered' on success", () => {
    expect(
      backupStatusLabel(
        fakeBackup({
          chainRegistrationStatus: "registered",
          coldStorageConfirmed: true,
        }),
      ),
    ).toBe("Chain registered");
  });

  it("'Registration failed — retry' on failure", () => {
    expect(
      backupStatusLabel(
        fakeBackup({
          chainRegistrationStatus: "registration-failed",
          chainRegistrationError: "RPC offline",
        }),
      ),
    ).toBe("Registration failed — retry");
  });
});

describe("hasBackupStarted + isBackupComplete", () => {
  it("hasBackupStarted is false for absent / empty placeholder", () => {
    expect(hasBackupStarted(null)).toBe(false);
    expect(hasBackupStarted(undefined)).toBe(false);
    expect(hasBackupStarted(emptySlhDsaBackup())).toBe(false);
  });

  it("hasBackupStarted is true for any record with createdAt > 0", () => {
    expect(hasBackupStarted(fakeBackup())).toBe(true);
    expect(
      hasBackupStarted(
        fakeBackup({ chainRegistrationStatus: "registration-failed" }),
      ),
    ).toBe(true);
  });

  it("isBackupComplete only when both cold-storage + chain are done", () => {
    // Just generated, no cold-storage confirm, no chain registration.
    expect(isBackupComplete(fakeBackup())).toBe(false);
    // Cold-storage confirmed but no chain registration.
    expect(
      isBackupComplete(fakeBackup({ coldStorageConfirmed: true })),
    ).toBe(false);
    // Chain registered but cold-storage not confirmed (impossible
    // via the UI but defensive).
    expect(
      isBackupComplete(
        fakeBackup({
          chainRegistrationStatus: "registered",
          coldStorageConfirmed: false,
        }),
      ),
    ).toBe(false);
    // Both — the happy path.
    expect(
      isBackupComplete(
        fakeBackup({
          chainRegistrationStatus: "registered",
          coldStorageConfirmed: true,
        }),
      ),
    ).toBe(true);
  });
});

describe("decodeBackupPublicKeyHex", () => {
  it("round-trips a 32-byte all-0xab pubkey", () => {
    const bytes = decodeBackupPublicKeyHex("ab".repeat(32));
    expect(bytes.length).toBe(32);
    expect(Array.from(bytes).every((b) => b === 0xab)).toBe(true);
  });

  it("round-trips an indexed-byte fixture", () => {
    let hex = "";
    for (let i = 0; i < 32; i++) hex += i.toString(16).padStart(2, "0");
    const bytes = decodeBackupPublicKeyHex(hex);
    for (let i = 0; i < 32; i++) {
      expect(bytes[i]).toBe(i);
    }
  });

  it("rejects wrong-length hex", () => {
    expect(() => decodeBackupPublicKeyHex("ab".repeat(16))).toThrow(
      /16 bytes, want 32/,
    );
    expect(() => decodeBackupPublicKeyHex("ab".repeat(33))).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => decodeBackupPublicKeyHex("z".repeat(64))).toThrow(
      /non-hex characters/,
    );
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — testing the runtime guard
    expect(() => decodeBackupPublicKeyHex(null)).toThrow(/must be a string/);
  });
});
