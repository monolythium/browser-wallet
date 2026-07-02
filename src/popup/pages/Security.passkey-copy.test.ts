// Part 5 — accurate passkey copy. Now that the per-tx passkey is a real
// SW-verified boundary (3b, 7419ad5), the Security passkey section must frame
// it as a cryptographically-verified per-tx approval (NOT a "fast-unlock
// shortcut") AND keep the over-limit-needs-password split honest.
//
// The passkey MODALS are portal-based (Modal -> createPortal), so they are not
// statically renderable under the Node test env — same posture as
// PasskeyRegisterModal / PasskeySignModal / SlhDsaBackupRevealModal. The
// Security policy intro is plain inline markup, so we pin it directly via
// renderToStaticMarkup.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Security } from "./Security.js";

const html = renderToStaticMarkup(
  createElement(Security, {
    onBack: () => {},
    onResetWallet: () => {},
    vaultId: "v1",
    vaultAddress: "0x1234567890abcdef1234567890abcdef12345678",
    chainIdHex: "0x7a69",
  }),
);

describe("Security passkey copy (Part 5 — accurate boundary copy)", () => {
  it("frames the passkey as a cryptographically-verified approval before signing", () => {
    expect(html).toContain("cryptographically verifies the passkey");
    expect(html).toContain("before signing");
  });

  it("keeps the over-limit-needs-password split honest", () => {
    // "Sends above the limit, and vault management, still require your password."
    expect(html).toMatch(/above the limit[\s\S]*require your password/);
  });

  it("drops the understated 'fast-unlock shortcut' framing", () => {
    expect(html).not.toContain("fast unlock");
    expect(html).not.toContain("fast-unlock");
    expect(html).not.toContain("shortcut");
  });

  it("does NOT overclaim that dApp or stake transactions are passkey-gated", () => {
    // The policy governs bare value sends only — no dApp/stake-gated claim.
    expect(html).not.toMatch(/dApp/i);
    expect(html).not.toMatch(/contract call[\s\S]*passkey/i);
  });
});
