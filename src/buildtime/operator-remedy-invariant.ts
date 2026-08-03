// Operator-remedy invariant.
//
// The wallet must not offer a remedy the shipped build cannot perform. Two
// claims are forbidden:
//
//   1. "switch to another operator" / "switch operators". The chain registry
//      ships a SINGLE rpc host (core-sdk registry: one entry in `rpc[]`), and
//      the RPC-override editor behind pages/Operators.tsx returns a
//      "Developer mode required" stub for a normal user. There is nothing to
//      switch to, and no ungated way to switch.
//   2. "uses other operators". Same reason: it claims a redundancy the
//      single-host fleet does not have, and it contradicts the sibling copy
//      that (correctly) says the balance is paused.
//
// WHY THIS EXISTS AS A TREE-WIDE SOURCE CHECK. A guard already existed —
// `operatorGuard` in pages/Help.test.tsx — and it passed truthfully for months
// while the forbidden sentence shipped on nine banner instances, on Home, and
// in shared/send-error.ts. It asserts over the rendered HELP PAGE, and the
// sentence lived in `chainHealthPresentation`, which Help never renders. The
// defect was not a weak guard but a guard pointed at ONE CONSUMER'S OUTPUT
// instead of at the source. That guard stays where it is, unchanged: it also
// pins a second refuted claim, and its fixture is the evidence it can fail.
//
// SCOPE, stated plainly because a half-understood gate is worse than none:
//   - It inspects SOURCE TEXT, with comments blanked. The invariant is about
//     what the wallet tells USERS, which lives in string literals; a comment
//     explaining why the phrase is banned is not a remedy offered to anyone.
//     If comments counted, the first exemptions would be the comments
//     documenting the rule — which is how an exemption list starts growing.
//   - The comment blanker is a small state machine over quotes and comment
//     markers. It does not parse regex literals, so a regex containing an
//     unescaped `/*` could blank following text. No such literal exists here,
//     and the failure mode is a MISSED hit, never a false one.
//   - It matches phrases, not meaning. A remedy worded differently escapes it.
//     It narrows the gap; it does not close it.
//   - Callers choose the file set. The companion test excludes `*.test.ts(x)`
//     so pages/Help.test.tsx can keep the refuted sentence as its fixture.

/** A forbidden remedy phrase and why the build cannot honour it. */
interface ForbiddenPhrase {
  pattern: RegExp;
  why: string;
}

const FORBIDDEN: ReadonlyArray<ForbiddenPhrase> = [
  {
    // "switch operators", "switch to another operator", "switching to a
    // different operator" — the family, not one phrasing. The narrow
    // `/switch to another operator/i` in Help.test.tsx missed the variant that
    // shipped in shared/send-error.ts.
    pattern:
      /switch(?:ing)?\s+(?:to\s+)?(?:another|a\s+different|other\s+)?\s*operators?\b/i,
    why: "operator switching is not available: the registry ships one host and the RPC-override editor is developer-gated",
  },
  {
    pattern: /uses?\s+other\s+operators\b/i,
    why: "claims a redundancy the single-host fleet does not have",
  },
];

/** Marker that exempts the FOLLOWING line, with a mandatory reason. */
const EXEMPTION = /^\s*(?:\/\/|\*)\s*operator-remedy-allow:\s*(\S.*)$/;

/** A forbidden remedy found in source. */
export interface OperatorRemedyViolation {
  /** 1-indexed line number. */
  line: number;
  /** The offending source line, trimmed. */
  text: string;
  /** The matched phrase, as written. */
  phrase: string;
  /** Why the build cannot honour it. */
  why: string;
}

/** A declared exemption. */
export interface RemedyExemption {
  line: number;
  reason: string;
}

/**
 * Blank out line and block comments, preserving line structure and every other
 * character position, so reported line numbers match the original source.
 * String literals are left intact — they are exactly what we want to inspect.
 */
function blankComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (quote !== null) {
      out.push(c);
      if (c === "\\") {
        // Copy the escaped character verbatim so an escaped quote can't end it.
        if (i + 1 < source.length) out.push(source[i + 1]!);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out.push(c);
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    if (c === "/" && next === "*") {
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      // Blank the closing "*/" too (guarding an unterminated block).
      if (i < source.length) {
        out.push(" ", " ");
        i += 2;
      }
      continue;
    }

    out.push(c);
    i += 1;
  }

  return out.join("");
}

/** Every declared `operator-remedy-allow` exemption, with its reason. */
export function findRemedyExemptions(source: string): RemedyExemption[] {
  const found: RemedyExemption[] = [];
  source.split("\n").forEach((line, idx) => {
    const m = EXEMPTION.exec(line);
    if (m) found.push({ line: idx + 1, reason: m[1]!.trim() });
  });
  return found;
}

/**
 * Every forbidden remedy phrase in `source`, outside comments, and not covered
 * by an `// operator-remedy-allow: <reason>` marker on the preceding line.
 * An exemption with no stated reason does not exempt anything.
 */
export function findOperatorRemedies(source: string): OperatorRemedyViolation[] {
  const rawLines = source.split("\n");
  const scanLines = blankComments(source).split("\n");
  const violations: OperatorRemedyViolation[] = [];

  scanLines.forEach((line, idx) => {
    const prev = idx > 0 ? rawLines[idx - 1]! : "";
    const exemption = EXEMPTION.exec(prev);
    if (exemption && exemption[1]!.trim().length > 0) return;

    for (const { pattern, why } of FORBIDDEN) {
      const m = pattern.exec(line);
      if (m) {
        violations.push({
          line: idx + 1,
          text: rawLines[idx]!.trim(),
          phrase: m[0],
          why,
        });
        break; // one report per line is enough to act on
      }
    }
  });

  return violations;
}

/**
 * Throw unless every supplied source is free of forbidden remedies. The message
 * names the file, the line, the phrase and the reason, so a failure is
 * actionable without opening the plan that produced this check.
 */
export function assertNoOperatorRemedies(
  files: ReadonlyArray<{ path: string; source: string }>,
): void {
  const lines: string[] = [];
  for (const file of files) {
    for (const v of findOperatorRemedies(file.source)) {
      lines.push(`  ${file.path}:${v.line} — "${v.phrase}" (${v.why})\n      ${v.text}`);
    }
  }
  if (lines.length > 0) {
    throw new Error(
      `Operator-remedy invariant violated in ${lines.length} place(s).\n` +
        `The wallet must not offer a remedy the shipped build cannot perform.\n` +
        lines.join("\n"),
    );
  }
}
