import { renderToStaticMarkup } from "react-dom/server";
import { MlDsa65Backend, bytesToHex } from "@monolythium/core-sdk/crypto";
import { describe, expect, it } from "vitest";

import type { MultisigSigner, MultisigVaultMeta } from "../../shared/multisig.js";
import {
  deriveNativeMultisigDisplay,
  NativeMultisigAddressCard,
  NativeMultisigAddressCardView,
  NATIVE_MULTISIG_NOT_IN_USE_COPY,
  NATIVE_MULTISIG_NOT_SPENDABLE_COPY,
  NATIVE_MULTISIG_CANNOT_DERIVE_COPY,
  type NativeMultisigDisplayResult,
} from "./NativeMultisigAddressCard.js";

// Reuse the commit-1 genesis-pinned foundation vector: 5 members from the 0xF0
// seeds at threshold 3 derive to the mono-core-pinned foundation monom.
const KAT_EXPECTED_MONOM = "monom16ets48dm0guclykv2hf2z7utnrarlhyw9az7nn";

function foundationPubkeyHexes(): string[] {
  const out: string[] = [];
  for (let idx = 1; idx <= 5; idx++) {
    const seed = new Uint8Array(32);
    seed[0] = 0xf0;
    seed[1] = idx;
    const backend = MlDsa65Backend.fromSeed(seed);
    out.push(bytesToHex(backend.publicKey()));
    backend.dispose();
  }
  return out;
}

function signer(pubkey: string, label: string, address: string): MultisigSigner {
  return { id: label, label, address, pubkey, role: "external" };
}

function member(fill: number): string {
  return bytesToHex(new Uint8Array(1952).fill(fill));
}

/** Decode the HTML entities SSR emits (apostrophes → &#x27;) so copy strings
 *  can be asserted verbatim. Structural checks (tags) stay on the raw HTML. */
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

describe("deriveNativeMultisigDisplay — reuses the commit-1 KAT vector", () => {
  it("derives the genesis-pinned foundation monom from the stored roster", () => {
    const signers = foundationPubkeyHexes().map((pk, i) =>
      signer(pk, `Signer ${i + 1}`, "0x" + "00".repeat(20)),
    );
    const r = deriveNativeMultisigDisplay(signers, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.display.monomAddress).toBe(KAT_EXPECTED_MONOM);
    expect(r.display.threshold).toBe(3);
    expect(r.display.memberCount).toBe(5);
    expect(r.display.members).toHaveLength(5);
    for (const m of r.display.members) {
      expect(m.pubkeyFingerprint).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  it("returns the members in canonical derivation (pubkey-sorted) order", () => {
    // Supplied out of order (C, A, B) with pubkeys fill(3) > fill(1) < fill(2).
    const signers = [
      signer(member(3), "C", "0x" + "33".repeat(20)),
      signer(member(1), "A", "0x" + "11".repeat(20)),
      signer(member(2), "B", "0x" + "22".repeat(20)),
    ];
    const r = deriveNativeMultisigDisplay(signers, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.display.members.map((m) => m.label)).toEqual(["A", "B", "C"]);
  });

  it("honestly reports cannot-derive when a member pubkey is malformed (no fabrication)", () => {
    const signers = [
      signer("0xdeadbeef", "bad", "0x" + "11".repeat(20)),
      signer(member(2), "ok", "0x" + "22".repeat(20)),
    ];
    const r = deriveNativeMultisigDisplay(signers, 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(NATIVE_MULTISIG_CANNOT_DERIVE_COPY);
  });
});

describe("NativeMultisigAddressCardView — honest copy, no send affordance", () => {
  const okResult: NativeMultisigDisplayResult = deriveNativeMultisigDisplay(
    [
      signer(member(1), "Alice", "0x" + "11".repeat(20)),
      signer(member(2), "Bob", "0x" + "22".repeat(20)),
    ],
    2,
  );

  it("renders the address + honest not-in-use / not-spendable copy, and NO interactive send affordance", () => {
    const html = renderToStaticMarkup(
      <NativeMultisigAddressCardView result={okResult} balanceText={null} />,
    );
    if (!okResult.ok) throw new Error("fixture");
    expect(html).toContain(okResult.display.monomAddress);
    expect(decode(html)).toContain(NATIVE_MULTISIG_NOT_IN_USE_COPY);
    expect(decode(html)).toContain(NATIVE_MULTISIG_NOT_SPENDABLE_COPY);
    expect(html).toContain("Threshold: 2 of 2");
    // The safety anchor: the card is display-only — NO button / send affordance.
    expect(html).not.toContain("<button");
    expect(html).not.toContain("role=\"button\"");
  });

  it("shows a balance line only when a real balance was read (no-mock)", () => {
    const withBal = renderToStaticMarkup(
      <NativeMultisigAddressCardView result={okResult} balanceText={"0"} />,
    );
    expect(withBal).toContain("On-chain balance:");
    const noBal = renderToStaticMarkup(
      <NativeMultisigAddressCardView result={okResult} balanceText={null} />,
    );
    expect(noBal).not.toContain("On-chain balance:");
  });

  it("renders the honest cannot-derive state (no address, no fabrication)", () => {
    const html = renderToStaticMarkup(
      <NativeMultisigAddressCardView
        result={{ ok: false, reason: NATIVE_MULTISIG_CANNOT_DERIVE_COPY }}
        balanceText={null}
      />,
    );
    expect(decode(html)).toContain(NATIVE_MULTISIG_CANNOT_DERIVE_COPY);
    expect(html).not.toContain("monom1");
  });
});

describe("NativeMultisigAddressCard — hidden when DEVELOPER_MODE is off (default)", () => {
  it("renders nothing by default (the flag defaults off, so the preview is gated away)", () => {
    const meta: MultisigVaultMeta = {
      signers: [
        signer(member(1), "Alice", "0x" + "11".repeat(20)),
        signer(member(2), "Bob", "0x" + "22".repeat(20)),
      ],
      threshold: 2,
      proposals: [],
      governance: [],
    };
    // SSR: useFeature's effect doesn't run → devMode stays false → card returns null.
    const html = renderToStaticMarkup(
      <NativeMultisigAddressCard meta={meta} vaultId="v1" chainId="0x10F2C" />,
    );
    expect(html).toBe("");
  });
});
