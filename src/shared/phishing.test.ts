// Phase 6 — phishing heuristics. Pure-function coverage; the UI plumbing
// (ReqConnect / ReqPersonalSignReal) consumes the returned warnings
// verbatim, so we pin the codes and severities here.

import { describe, expect, it } from "vitest";
import { detectOriginWarnings, detectMessageWarnings } from "./phishing.js";

describe("detectOriginWarnings — legitimate origins", () => {
  it("returns no warnings for canonical brand domains", () => {
    expect(detectOriginWarnings("https://monolythium.org")).toEqual([]);
    expect(detectOriginWarnings("https://app.monolythium.vision")).toEqual([]);
    expect(detectOriginWarnings("https://opensea.io")).toEqual([]);
  });

  it("returns no warnings for localhost (any port, any scheme)", () => {
    expect(detectOriginWarnings("http://localhost:3000")).toEqual([]);
    expect(detectOriginWarnings("http://127.0.0.1:8080")).toEqual([]);
    expect(detectOriginWarnings("http://app.localhost")).toEqual([]);
  });
});

describe("detectOriginWarnings — invalid input", () => {
  it("flags missing origin as danger", () => {
    const r = detectOriginWarnings("");
    expect(r).toHaveLength(1);
    expect(r[0]?.code).toBe("missing-origin");
    expect(r[0]?.level).toBe("danger");
  });

  it("flags malformed origin as danger", () => {
    const r = detectOriginWarnings("not-a-url");
    expect(r).toHaveLength(1);
    expect(r[0]?.code).toBe("malformed-origin");
  });
});

describe("detectOriginWarnings — transport heuristic", () => {
  it("flags plain http on a non-localhost origin as danger", () => {
    const r = detectOriginWarnings("http://example.com");
    expect(r.map((w) => w.code)).toContain("non-https");
    expect(r.find((w) => w.code === "non-https")?.level).toBe("danger");
  });

  it("flags ws:// origins as non-https too", () => {
    const r = detectOriginWarnings("ws://example.com");
    expect(r.map((w) => w.code)).toContain("non-https");
  });
});

describe("detectOriginWarnings — punycode / IDN", () => {
  it("flags an xn-- hostname as danger", () => {
    // Real punycode: xn--80akhbyknj4f → испытание (Russian for "test").
    const r = detectOriginWarnings("https://xn--80akhbyknj4f.org");
    expect(r.map((w) => w.code)).toContain("punycode");
    expect(r.find((w) => w.code === "punycode")?.level).toBe("danger");
  });

  it("flags a Unicode hostname that the URL constructor IDN-to-ASCIIs", () => {
    // The URL constructor converts non-ASCII chars to xn-- form, so the
    // resulting URL.hostname carries the punycode marker even though the
    // dApp sent Unicode.
    const r = detectOriginWarnings("https://испытание.org");
    expect(r.map((w) => w.code)).toContain("punycode");
  });
});

describe("detectOriginWarnings — homograph", () => {
  it("flags a Cyrillic 'а' inside a Latin-looking hostname", () => {
    // U+0430 (Cyrillic small a) instead of U+0061 (Latin small a).
    const r = detectOriginWarnings("https://monolythiuм.org");
    // Should flag homograph at minimum; brand-lookalike also fires
    // because the visible characters spell "monolythium" but the
    // hostname isn't on the canonical list.
    expect(r.map((w) => w.code)).toContain("homograph");
  });
});

describe("detectOriginWarnings — brand lookalike", () => {
  it("flags a non-canonical hostname containing 'monolythium'", () => {
    const r = detectOriginWarnings("https://monolythium-airdrop.com");
    expect(r.map((w) => w.code)).toContain("brand-lookalike");
    expect(r.find((w) => w.code === "brand-lookalike")?.level).toBe("danger");
  });

  it("does NOT flag a subdomain of the canonical brand", () => {
    // app.monolythium.org ends with .monolythium.org → canonical match.
    const r = detectOriginWarnings("https://app.monolythium.org");
    expect(r.map((w) => w.code)).not.toContain("brand-lookalike");
  });

  it("flags non-canonical metamask lookalikes", () => {
    const r = detectOriginWarnings("https://metamask-claim.xyz");
    expect(r.map((w) => w.code)).toContain("brand-lookalike");
    // .xyz is a risky TLD on a brand-lookalike — both signals fire.
    expect(r.map((w) => w.code)).toContain("risky-tld");
  });
});

describe("detectOriginWarnings — risky TLD", () => {
  it("flags .tk / .top / .xyz on non-canonical hostnames as warning", () => {
    for (const tld of ["tk", "top", "xyz"]) {
      const r = detectOriginWarnings(`https://example.${tld}`);
      expect(r.map((w) => w.code)).toContain("risky-tld");
      expect(r.find((w) => w.code === "risky-tld")?.level).toBe("warning");
    }
  });

  it("does not double-flag canonical brand domains even on .io / .com", () => {
    const r = detectOriginWarnings("https://opensea.io");
    expect(r.map((w) => w.code)).not.toContain("risky-tld");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectMessageWarnings
// ─────────────────────────────────────────────────────────────────────────────

describe("detectMessageWarnings — empty / non-string input", () => {
  it("returns [] for empty string", () => {
    expect(detectMessageWarnings("")).toEqual([]);
  });

  it("returns [] for non-string runtime input", () => {
    // @ts-expect-error — runtime guard test
    expect(detectMessageWarnings(null)).toEqual([]);
    // @ts-expect-error
    expect(detectMessageWarnings(undefined)).toEqual([]);
  });
});

describe("detectMessageWarnings — printable UTF-8 messages", () => {
  it("returns [] for a normal SIWE message", () => {
    const siwe = [
      "monolythium.org wants you to sign in with your account.",
      "",
      "URI: https://monolythium.org",
      "Version: 1",
      "Chain ID: 69420",
      "Nonce: a1b2c3d4",
      "Issued At: 2026-05-15T10:00:00Z",
    ].join("\n");
    expect(detectMessageWarnings(siwe)).toEqual([]);
  });

  it("returns [] for a plain question prompt", () => {
    expect(detectMessageWarnings("Confirm membership in DAO #42")).toEqual([]);
  });
});

describe("detectMessageWarnings — ABI-shaped hex", () => {
  it("flags hex that matches selector + 32-byte arg shape as danger", () => {
    // approve(address,uint256) selector 0x095ea7b3 + two 32-byte args.
    const calldata =
      "0x095ea7b3" +
      "0".repeat(64) +
      "0".repeat(64);
    const r = detectMessageWarnings(calldata);
    expect(r.map((w) => w.code)).toContain("abi-shaped-hex");
    expect(r.find((w) => w.code === "abi-shaped-hex")?.level).toBe("danger");
  });

  it("does NOT flag a short hex string that isn't shape-aligned", () => {
    // 8-char selector, no args — too short to be a tx call; might be a
    // random hash. We only flag the (selector + ≥1 arg) shape.
    expect(detectMessageWarnings("0x12345678").every((w) => w.code !== "abi-shaped-hex")).toBe(true);
  });
});

describe("detectMessageWarnings — binary-hex blob", () => {
  it("flags hex that decodes to non-printable bytes as warning", () => {
    // Random non-printable bytes (0x01, 0x02, …).
    const hex = "0x010203040506";
    const r = detectMessageWarnings(hex);
    expect(r.map((w) => w.code)).toContain("binary-hex");
    expect(r.find((w) => w.code === "binary-hex")?.level).toBe("warning");
  });

  it("does NOT flag hex that decodes to a printable UTF-8 string", () => {
    // "Hello" in hex.
    const hex = "0x48656c6c6f";
    expect(detectMessageWarnings(hex)).toEqual([]);
  });

  it("does NOT add 'binary-hex' when 'abi-shaped-hex' already fired", () => {
    const calldata = "0x095ea7b3" + "0".repeat(64) + "0".repeat(64);
    const codes = detectMessageWarnings(calldata).map((w) => w.code);
    expect(codes).toContain("abi-shaped-hex");
    expect(codes).not.toContain("binary-hex");
  });
});

describe("detectMessageWarnings — Permit / Permit2 keywords", () => {
  it("flags a text body containing 'Permit2'", () => {
    const r = detectMessageWarnings(
      "Authorize Permit2 to spend up to 1,000,000 USDC for spender 0xabc",
    );
    expect(r.map((w) => w.code)).toContain("permit-keyword");
    expect(r.find((w) => w.code === "permit-keyword")?.level).toBe("danger");
  });

  it("flags a text body containing 'approve('", () => {
    const r = detectMessageWarnings("approve(spender, MAX_UINT256) for vault gas relay");
    expect(r.map((w) => w.code)).toContain("permit-keyword");
  });

  it("flags hex that decodes to text containing 'Permit('", () => {
    const text = "Permit(owner,spender,value,nonce,deadline)";
    const hex =
      "0x" +
      Array.from(new TextEncoder().encode(text))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const r = detectMessageWarnings(hex);
    expect(r.map((w) => w.code)).toContain("permit-keyword");
  });

  it("emits at most one permit-keyword warning per message", () => {
    const r = detectMessageWarnings("Permit(...) approve(...) transferFrom(...)");
    expect(r.filter((w) => w.code === "permit-keyword")).toHaveLength(1);
  });
});

describe("detectMessageWarnings — oversized payload", () => {
  it("flags a 5KB body as warning", () => {
    const big = "x".repeat(5 * 1024);
    const r = detectMessageWarnings(big);
    expect(r.map((w) => w.code)).toContain("oversized-payload");
    expect(r.find((w) => w.code === "oversized-payload")?.level).toBe("warning");
  });

  it("does NOT flag a 1KB body", () => {
    const med = "x".repeat(1024);
    expect(detectMessageWarnings(med).every((w) => w.code !== "oversized-payload")).toBe(true);
  });
});
