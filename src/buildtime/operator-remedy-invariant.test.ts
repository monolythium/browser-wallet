// The static assertion behind the operator-remedy invariant.
//
// The wallet must not offer a remedy the shipped build cannot perform. The
// registry ships ONE rpc host and the RPC-override editor is developer-gated,
// so "switch to another operator" is advice no user can take, and "uses other
// operators" claims a redundancy that does not exist.
//
// A guard for this already existed — `operatorGuard` in pages/Help.test.tsx —
// and it passed truthfully while the phrase shipped on nine banner instances,
// on Home and in the send-error copy. It was pointed at the wrong artifact: it
// asserts over the rendered HELP PAGE, and the phrase lived in
// chainHealthPresentation, which Help never renders. It was also narrower than
// the phrase family, matching "switch to another operator" but not the
// "switch operators" variant in shared/send-error.ts.
//
// This promotes it to a source-tree check. The tests below pin the ANALYSER
// against synthetic sources first, so it is known to FAIL when it should rather
// than merely observed passing today, and only then run it over the real tree.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertNoOperatorRemedies,
  findOperatorRemedies,
  findRemedyExemptions,
} from "./operator-remedy-invariant";

describe("findOperatorRemedies — what the analyser treats as an offence", () => {
  it("accepts source with no remedy claim", () => {
    expect(
      findOperatorRemedies('const body = "The wallet reconnects on its own.";'),
    ).toEqual([]);
  });

  it("flags the exact sentence that shipped, naming its line and phrase", () => {
    const src = [
      "const a = 1;",
      'const body = "The app reconnects once it matches again, or switch to another operator on your wallet\'s network.";',
    ].join("\n");
    const found = findOperatorRemedies(src);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.phrase.toLowerCase()).toContain("switch to another operator");
    expect(found[0]!.why).toMatch(/one host|developer-gated/i);
  });

  // The variant the old Help.test.tsx regex could not match, which is why the
  // promotion widens the pattern rather than only widening the scope.
  it("flags the 'switch operators' variant the narrow regex missed", () => {
    const found = findOperatorRemedies(
      'const b = "once an operator recovers, or you can switch operators.";',
    );
    expect(found).toHaveLength(1);
  });

  it("flags the multi-operator redundancy claim", () => {
    const found = findOperatorRemedies(
      'const c = "The wallet skips it automatically and uses other operators.";',
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.why).toMatch(/redundancy/i);
  });

  // The invariant is about what the wallet TELLS USERS. A comment explaining
  // why the phrase is banned is not a remedy offered to anyone — and if
  // comments counted, the first entries in the exemption list would be the
  // comments documenting the rule, which is how an exemption list starts
  // growing.
  it("ignores line and block comments", () => {
    expect(
      findOperatorRemedies("// no switch to another operator remedy here"),
    ).toEqual([]);
    expect(
      findOperatorRemedies("/* switch operators is not offered */\nconst x = 1;"),
    ).toEqual([]);
  });

  it("does not mistake a URL for a comment", () => {
    expect(
      findOperatorRemedies(
        'const u = "https://example.test/x"; const d = "switch operators";',
      ),
    ).toHaveLength(1);
  });

  it("honours a marked exemption on the preceding line", () => {
    const src = [
      "// operator-remedy-allow: quoting the refuted draft as a fixture",
      'const d = "switch to another operator";',
    ].join("\n");
    expect(findOperatorRemedies(src)).toEqual([]);
  });

  it("rejects an exemption with no stated reason", () => {
    const src = [
      "// operator-remedy-allow:",
      'const e = "switch to another operator";',
    ].join("\n");
    expect(findOperatorRemedies(src)).toHaveLength(1);
  });
});

describe("assertNoOperatorRemedies — how a failure reads", () => {
  it("names the file, the line, the phrase and the reason", () => {
    const files = [
      {
        path: "src/popup/components.tsx",
        source: '\nconst t = "or switch to another operator on your network.";',
      },
    ];
    expect(() => assertNoOperatorRemedies(files)).toThrow(
      /src\/popup\/components\.tsx:2/,
    );
    expect(() => assertNoOperatorRemedies(files)).toThrow(/switch to another operator/i);
    expect(() => assertNoOperatorRemedies(files)).toThrow(/one host|developer-gated/i);
  });

  it("passes silently on clean sources", () => {
    expect(() =>
      assertNoOperatorRemedies([{ path: "a.ts", source: "const ok = 1;" }]),
    ).not.toThrow();
  });
});

// ── The real tree ────────────────────────────────────────────────────────────
//
// Test files are OUT OF SCOPE: pages/Help.test.tsx keeps the refuted sentence
// as `REFUTED_DRAFT_CLAIMS.switchOperators`, which is the evidence its own
// negative guard is not passing vacuously. A check that forbade its own fixture
// would force the fixture to be deleted.

const SRC_DIR = new URL("../", import.meta.url);

const SKIP_DIRS = new Set(["node_modules", "dist"]);

function collectSources(dir: URL, rel = ""): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...collectSources(new URL(`${name}/`, dir), `${rel}${name}/`));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue; // fixtures live here — see above
    if (name.startsWith("operator-remedy-invariant")) continue; // this check itself
    out.push({
      path: `src/${rel}${name}`,
      source: readFileSync(new URL(name, dir), "utf8"),
    });
  }
  return out;
}

describe("the real source tree", () => {
  const files = collectSources(SRC_DIR);

  it("scans a meaningful number of files (the walk actually found the tree)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.path === "src/popup/components.tsx")).toBe(true);
  });

  it("offers no operator-switching remedy anywhere in shipped source", () => {
    assertNoOperatorRemedies(files);
  });

  // An exemption is a hole. None is needed today, and this makes adding one a
  // visible diff with a written reason rather than a silent append.
  it("carries no exemptions", () => {
    const exempted = files.flatMap((f) =>
      findRemedyExemptions(f.source).map((e) => `${f.path}:${e.line} — ${e.reason}`),
    );
    expect(exempted).toEqual([]);
  });
});
