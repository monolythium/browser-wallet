import { describe, expect, it } from "vitest";
import { resolveVaultChipLabel } from "./VaultPicker";

// The chip label precedence is the whole of the "—" flash fix (C): the parent
// seeds the already-fetched active label so the chip shows the real wallet name
// on first paint, while this component's own bgVaultsList result supersedes it
// once in. Tested as a pure unit because the supersede edge needs the self-
// fetch effect to have run, which the SSR render path cannot reach.
describe("resolveVaultChipLabel", () => {
  it("first paint: shows the parent-seeded label while the self-fetch is still pending (no '—' flash)", () => {
    // vaults not yet loaded → self-fetched label is undefined/null.
    expect(resolveVaultChipLabel(undefined, "Wallet 1")).toBe("Wallet 1");
    expect(resolveVaultChipLabel(null, "Wallet 1")).toBe("Wallet 1");
  });

  it("supersede: the self-fetched active label wins over the seed once resolved", () => {
    // Even if the seed is stale/different, the authoritative self-fetched
    // label (carries isActive) takes precedence.
    expect(resolveVaultChipLabel("Real Active", "Stale Seed")).toBe(
      "Real Active",
    );
  });

  it("switch: a new active label flows straight through", () => {
    expect(resolveVaultChipLabel("Wallet 2", "Wallet 1")).toBe("Wallet 2");
  });

  it("em-dash floor: neither self-fetched nor seeded resolved", () => {
    expect(resolveVaultChipLabel(undefined, undefined)).toBe("—");
    expect(resolveVaultChipLabel(null, undefined)).toBe("—");
  });
});
