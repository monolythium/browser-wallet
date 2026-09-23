import { describe, expect, it } from "vitest";

import {
  hardenedOperators,
  hardenedChains,
  overrideDialable,
  overrideRefusalReason,
  overrideWithinFleet,
} from "./hardened-dial.js";
import {
  APPROVED_LOOPBACK_HOSTS,
  APPROVED_LOOPBACK_SCHEMES,
  REFUSAL_NOT_LOCAL,
  REFUSAL_TOGGLE_OFF,
} from "./loopback.js";
import { LOOPBACK_SOURCES } from "../buildtime/csp.js";
import { validateOperatorList } from "./operators.js";
import type { OperatorEntry } from "./operators.js";

const DEFAULTS: ReadonlyArray<OperatorEntry> = [
  { name: "operator-1", region: "fsn1", rpc: "http://10.0.0.1:8545" },
  { name: "operator-2", region: "hel1", rpc: "http://10.0.0.2:8545" },
];
const OVERRIDE: OperatorEntry[] = [
  { name: "custom", region: "x", rpc: "http://198.51.100.7:8545" },
];

describe("hardenedOperators — the operator brick-preventer", () => {
  it("HARDENED rejects an override with a NON-FLEET host → allowlisted defaults", () => {
    // A custom host isn't in the strict CSP allowlist, so honoring it would
    // brick every RPC. Hardened builds fall back to the defaults.
    const got = hardenedOperators(DEFAULTS, OVERRIDE, true);
    expect(got.map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
    expect(got.map((o) => o.rpc)).not.toContain("http://198.51.100.7:8545");
  });

  it("HARDENED HONORS a within-fleet REORDER (route around a degraded default)", () => {
    // The exact "Use this operator" case: the built-in fleet, reordered to pin
    // a healthy operator first. Every host is already in the CSP allowlist, so
    // it can't be blocked — it must be applied, not reverted to defaults.
    const reordered: OperatorEntry[] = [DEFAULTS[1]!, DEFAULTS[0]!];
    const got = hardenedOperators(DEFAULTS, reordered, true);
    expect(got.map((o) => o.rpc)).toEqual([
      "http://10.0.0.2:8545",
      "http://10.0.0.1:8545",
    ]);
  });

  it("HARDENED HONORS a within-fleet SUBSET / pin (drop a degraded default)", () => {
    const pinned: OperatorEntry[] = [
      { name: "pinned", region: "", rpc: "http://10.0.0.2:8545" },
    ];
    // Matched by rpc ORIGIN, so a renamed/blank-region entry still counts as
    // in-fleet.
    const got = hardenedOperators(DEFAULTS, pinned, true);
    expect(got.map((o) => o.rpc)).toEqual(["http://10.0.0.2:8545"]);
  });

  it("HARDENED rejects a MIXED override (one custom host taints the whole list)", () => {
    const mixed: OperatorEntry[] = [DEFAULTS[0]!, OVERRIDE[0]!];
    expect(hardenedOperators(DEFAULTS, mixed, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("HARDENED honors a fleet entry with an in-fleet explicit wsRpc; rejects an out-of-fleet wsRpc", () => {
    const okWs: OperatorEntry[] = [
      { name: "operator-1", region: "fsn1", rpc: "http://10.0.0.1:8545", wsRpc: "ws://10.0.0.1:8546" },
    ];
    expect(hardenedOperators(DEFAULTS, okWs, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
    ]);
    const badWs: OperatorEntry[] = [
      { name: "operator-1", region: "fsn1", rpc: "http://10.0.0.1:8545", wsRpc: "ws://10.0.0.9:8546" },
    ];
    // rpc is in-fleet but the explicit wsRpc host is not → the whole override
    // is rejected (it would trip the ws CSP), so defaults.
    expect(hardenedOperators(DEFAULTS, badWs, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("HARDENED with no override → defaults", () => {
    expect(hardenedOperators(DEFAULTS, null, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("DEV honors the stored override (replace semantics, unchanged)", () => {
    const got = hardenedOperators(DEFAULTS, OVERRIDE, false);
    expect(got.map((o) => o.rpc)).toEqual(["http://198.51.100.7:8545"]);
  });

  it("DEV with no override → defaults (unchanged)", () => {
    expect(hardenedOperators(DEFAULTS, null, false).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("returns fresh copies (mutating the result can't corrupt the defaults)", () => {
    const got = hardenedOperators(DEFAULTS, null, true);
    got[0]!.rpc = "mutated";
    expect(DEFAULTS[0]!.rpc).toBe("http://10.0.0.1:8545");
    // A within-fleet honored override is also a copy, not the input reference.
    const passthrough: OperatorEntry[] = [DEFAULTS[1]!, DEFAULTS[0]!];
    const honored = hardenedOperators(DEFAULTS, passthrough, true);
    honored[0]!.rpc = "mutated";
    expect(passthrough[0]!.rpc).toBe("http://10.0.0.2:8545");
  });
});

describe("overrideWithinFleet — the CSP-safety predicate", () => {
  it("true for a reorder, subset, and origin-matched (renamed) entry", () => {
    expect(overrideWithinFleet(DEFAULTS, [DEFAULTS[1]!, DEFAULTS[0]!])).toBe(true);
    expect(overrideWithinFleet(DEFAULTS, [DEFAULTS[0]!])).toBe(true);
    expect(
      overrideWithinFleet(DEFAULTS, [
        { name: "x", region: "", rpc: "http://10.0.0.1:8545" },
      ]),
    ).toBe(true);
  });

  it("false when any entry carries a non-fleet host or unparseable rpc", () => {
    expect(overrideWithinFleet(DEFAULTS, OVERRIDE)).toBe(false);
    expect(overrideWithinFleet(DEFAULTS, [DEFAULTS[0]!, OVERRIDE[0]!])).toBe(false);
    expect(
      overrideWithinFleet(DEFAULTS, [{ name: "x", region: "", rpc: "not a url" }]),
    ).toBe(false);
  });

  it("rejects same-host plaintext downgrades of secure release defaults", () => {
    const secureDefaults: ReadonlyArray<OperatorEntry> = [
      {
        name: "operator-1",
        region: "global",
        rpc: "https://rpc.monolythium.com",
        wsRpc: "wss://rpc.monolythium.com/ws",
      },
    ];
    const downgrade: OperatorEntry[] = [
      {
        name: "operator-1",
        region: "global",
        rpc: "http://rpc.monolythium.com",
        wsRpc: "ws://rpc.monolythium.com/ws",
      },
    ];

    expect(overrideWithinFleet(secureDefaults, downgrade)).toBe(false);
    expect(hardenedOperators(secureDefaults, downgrade, true)).toEqual(
      secureDefaults,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The P6-001 loopback re-open. Approval was for a node on the user's own
// machine; remote hosts were declined, so they must stay refused even with the
// opt-in on.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL: OperatorEntry[] = [
  { name: "my node", region: "", rpc: "http://localhost:8545" },
];

describe("overrideDialable — what a hardened build will dial", () => {
  it("a fleet override is dialable regardless of the opt-in", () => {
    const reordered: OperatorEntry[] = [DEFAULTS[1]!, DEFAULTS[0]!];
    expect(overrideDialable(DEFAULTS, reordered, false)).toBe(true);
    expect(overrideDialable(DEFAULTS, reordered, true)).toBe(true);
  });

  it("a loopback override is dialable ONLY with the opt-in on", () => {
    expect(overrideDialable(DEFAULTS, LOCAL, false)).toBe(false);
    expect(overrideDialable(DEFAULTS, LOCAL, true)).toBe(true);
  });

  it("a REMOTE override stays refused even with the opt-in on — remote was declined", () => {
    expect(overrideDialable(DEFAULTS, OVERRIDE, true)).toBe(false);
  });

  it("accepts a mix of fleet and loopback entries", () => {
    const mixed: OperatorEntry[] = [LOCAL[0]!, DEFAULTS[0]!];
    expect(overrideDialable(DEFAULTS, mixed, true)).toBe(true);
  });

  it("rejects a loopback rpc carrying a REMOTE explicit wsRpc", () => {
    const smuggled: OperatorEntry[] = [
      { name: "n", region: "", rpc: "http://localhost:8545", wsRpc: "ws://evil.com:8546" },
    ];
    expect(overrideDialable(DEFAULTS, smuggled, true)).toBe(false);
  });

  it("accepts a loopback rpc with a loopback explicit wsRpc", () => {
    const ok: OperatorEntry[] = [
      { name: "n", region: "", rpc: "http://localhost:8545", wsRpc: "ws://127.0.0.1:8546" },
    ];
    expect(overrideDialable(DEFAULTS, ok, true)).toBe(true);
  });
});

describe("hardenedOperators — the loopback opt-in", () => {
  it("opt-in OFF: a stored loopback override is NOT dialled (fail closed)", () => {
    const got = hardenedOperators(DEFAULTS, LOCAL, true, false);
    expect(got.map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });

  it("opt-in ON: the loopback override IS dialled", () => {
    const got = hardenedOperators(DEFAULTS, LOCAL, true, true);
    expect(got.map((o) => o.rpc)).toEqual(["http://localhost:8545"]);
  });

  it("opt-in ON does not unlock a remote host", () => {
    const got = hardenedOperators(DEFAULTS, OVERRIDE, true, true);
    expect(got.map((o) => o.rpc)).not.toContain("http://198.51.100.7:8545");
  });

  it("defaults to OFF when the flag is omitted — every existing caller fails closed", () => {
    expect(hardenedOperators(DEFAULTS, LOCAL, true).map((o) => o.rpc)).toEqual([
      "http://10.0.0.1:8545",
      "http://10.0.0.2:8545",
    ]);
  });
});

// THE TRAP: gates 1-5 are in-process, gate 6 is the browser. A host that
// survives the runtime gates but is not covered by the allowlist would be
// accepted, persisted, dialled -- and then blocked by the CSP, turning an
// honest refusal into a silent failure. This asserts the whole chain agrees.
describe("all gates agree — validator → dialable → dial-set → allowlist", () => {
  const httpSources = LOOPBACK_SOURCES.filter((s) => s.startsWith("http://"));

  it("a loopback operator survives every runtime gate AND is allowlisted", () => {
    const wire = [{ name: "my node", region: "", rpc: "http://127.0.0.1:8545" }];

    const validated = validateOperatorList(wire); // gate 2
    expect(validated).not.toBeNull();
    expect(overrideDialable(DEFAULTS, validated!, true)).toBe(true); // gate 3
    const dialled = hardenedOperators(DEFAULTS, validated!, true, true); // gates 4+5
    expect(dialled.map((o) => o.rpc)).toEqual(["http://127.0.0.1:8545"]);

    // gate 6, in proxy: whatever survived must be covered by a CSP source.
    for (const op of dialled) {
      const host = new URL(op.rpc).hostname;
      expect(httpSources).toContain(`http://${host}:*`);
    }
  });

  it("a remote operator is stopped BEFORE gate 6 — never dialled, never CSP-blocked", () => {
    const wire = [{ name: "remote", region: "", rpc: "http://198.51.100.7:8545" }];
    const validated = validateOperatorList(wire);
    expect(validated).not.toBeNull(); // the validator alone does NOT stop it
    expect(overrideDialable(DEFAULTS, validated!, true)).toBe(false);
    const dialled = hardenedOperators(DEFAULTS, validated!, true, true);
    for (const op of dialled) {
      expect(op.rpc).not.toBe("http://198.51.100.7:8545");
    }
  });
});

// Two conditions were sharing one refusal string, and it was wrong for the
// second: telling a user to turn on a toggle that would not help them, because
// their host stays refused either way.
describe("overrideRefusalReason — which refusal, and why", () => {
  const remote = (rpc: string): OperatorEntry[] => [
    { name: "n", region: "", rpc },
  ];

  it("returns null when the override is dialable", () => {
    expect(overrideRefusalReason(DEFAULTS, LOCAL, true)).toBeNull();
    const reordered: OperatorEntry[] = [DEFAULTS[1]!, DEFAULTS[0]!];
    expect(overrideRefusalReason(DEFAULTS, reordered, false)).toBeNull();
  });

  it("an ALLOWED form with the toggle off blames the toggle", () => {
    const reason = overrideRefusalReason(DEFAULTS, LOCAL, false);
    expect(reason).toBe(REFUSAL_TOGGLE_OFF);
    expect(reason).toMatch(/Allow a local node/);
  });

  // The host decides, not the toggle: each of these stays refused with the
  // opt-in ON, so pointing at the toggle would be advice that does not help.
  it.each([
    ["a typo'd address", "http://121.0.0.1:03"],
    ["another 127/8 address the allowlist omits", "http://127.0.0.2:8545"],
    ["the unspecified address", "http://0.0.0.0:8545"],
    ["a link-local address", "http://169.254.1.1:8545"],
    ["a remote hostname", "http://rpc.example.com:8545"],
    ["https on loopback", "https://127.0.0.1:8545"],
    ["a host merely containing localhost", "http://localhost.evil.com:8545"],
  ])("%s gets the not-local message, toggle ON", (_label, rpc) => {
    expect(overrideRefusalReason(DEFAULTS, remote(rpc), true)).toBe(
      REFUSAL_NOT_LOCAL,
    );
  });

  it("…and the SAME message with the toggle off — the toggle is not the reason", () => {
    for (const rpc of ["http://121.0.0.1:03", "http://127.0.0.2:8545"]) {
      expect(overrideRefusalReason(DEFAULTS, remote(rpc), false)).toBe(
        REFUSAL_NOT_LOCAL,
      );
    }
  });

  // 127.0.0.2 IS loopback. The message must list the allowed forms, which is
  // what that user needs — and must NOT tell them it "isn't local".
  it("never tells a genuinely-loopback host that it is not local", () => {
    const reason = overrideRefusalReason(
      DEFAULTS,
      remote("http://127.0.0.2:8545"),
      true,
    )!;
    for (const host of APPROVED_LOOPBACK_HOSTS) expect(reason).toContain(host);
  });

  it("derives the forms and schemes from the predicate's own source", () => {
    for (const host of APPROVED_LOOPBACK_HOSTS) {
      expect(REFUSAL_NOT_LOCAL).toContain(host);
    }
    for (const scheme of APPROVED_LOOPBACK_SCHEMES) {
      expect(REFUSAL_NOT_LOCAL).toContain(`${scheme}//`);
    }
  });
});

describe("hardenedChains — the custom-chain brick-preventer", () => {
  const builtin = { "0x10F2C": { name: "Monolythium Testnet", builtin: true } };
  const user = { "0x1": { name: "Custom EVM", builtin: false } };

  it("HARDENED dials only the built-in chain(s); custom chains are dropped", () => {
    const got = hardenedChains(builtin, user, true);
    expect(Object.keys(got)).toEqual(["0x10F2C"]);
    expect(got["0x1"]).toBeUndefined();
  });

  it("DEV merges built-in + user chains (unchanged)", () => {
    const got = hardenedChains(builtin, user, false);
    expect(Object.keys(got).sort()).toEqual(["0x1", "0x10F2C"]);
  });

  it("HARDENED returns a copy, not the builtin reference", () => {
    expect(hardenedChains(builtin, user, true)).not.toBe(builtin);
  });
});
