// Container-write invariant assertion (H1).
//
// Every mutation of the v4 vaults container is supposed to go through one of two
// primitives in `src/background/keystore-mldsa.ts` — `mutateContainer` or
// `createContainer`. Each owns the container lock, the container read and the
// container write, so a writer that routes through one cannot skip the lock,
// cannot supply its own container object, and cannot persist a snapshot it took
// before acquiring. Calling the raw writer `saveVaultsContainerV4` directly
// sidesteps all of that.
//
// Until now that was a convention: correct by review, unenforced. This module is
// what makes it checkable. It inspects the module's SOURCE TEXT and reports every
// direct call to the raw writer that is not inside one of the two primitives.
//
// WHY A SOURCE CHECK rather than a runtime one. The obvious runtime guard — make
// `saveVaultsContainerV4` refuse unless the container lock is held — cannot ship
// here. The keystore guard suite calls it directly and deliberately lock-free to
// pin its rejection and success paths, and those tests are never edited. A source
// check sits outside that collision entirely: it inspects text, so it has no
// opinion about how a test calls the function at runtime.
//
// Unlike its neighbours in this directory, this assertion is run by the test
// suite rather than from vite.config.ts — it judges source, not an emitted build
// artifact, so there is nothing about the packaged output for it to read.
//
// Scope, stated plainly because a half-understood gate is worse than none:
//   - It inspects a direct CALL — the identifier followed by `(`. Indirection
//     defeats it: aliasing the function to another name, dynamic dispatch, or
//     reaching it from another module through the `__internalV4Multi` re-export.
//     It narrows the gap; it does not close it.
//   - It attributes a call to the nearest preceding top-level function
//     declaration, and stops attributing at the next column-0 `}`. A call that is
//     not inside any top-level function is reported as top-level.
//   - It is a static check over one file's text. It says nothing about lock
//     ordering, about whether a primitive is itself correct, or about the
//     wallet-state wipe, which removes the container by key-prefix scan rather
//     than through either primitive and is serialised on the same lock instead.

import { escapeRegExpExceptWildcard } from "./escape-regexp.js";

/** A direct call to the raw container writer from outside the primitives. */
export interface RawContainerWriteViolation {
  /** 1-indexed line number of the offending call. */
  line: number;
  /** Name of the enclosing top-level function, or null when at top level. */
  enclosing: string | null;
  /** The offending source line, trimmed. */
  text: string;
}

/** The raw writer that must not be called directly. */
const RAW_WRITER = "saveVaultsContainerV4";

/** `RAW_WRITER` made safe to interpolate. It carries no metacharacter today, so
 *  this changes nothing now — it is here because a rename is the realistic way
 *  this guard breaks. `$` is legal in a JavaScript identifier and is a regex
 *  anchor, so `save$Vault` would compile to a pattern that can never match, and
 *  the guard would report a clean tree it had stopped inspecting. */
const RAW_WRITER_PATTERN = escapeRegExpExceptWildcard(RAW_WRITER);

/** The only functions permitted to call it. Each owns the lock, the read and
 *  the write; see the invariant note above `saveVaultsContainerV4` itself. */
const PRIMITIVES = ["mutateContainer", "createContainer"] as const;

/** A top-level function declaration: `function f`, `async function f`,
 *  `export function f`, `export async function f` — at column 0. */
const TOP_LEVEL_FN = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;

/** The raw writer's own declaration, which is not a call to it. */
const RAW_WRITER_DECL = new RegExp(
  `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${RAW_WRITER_PATTERN}\\b`,
);

/** A direct call: the identifier followed by an open paren. A bare mention —
 *  the export list, a doc reference — is deliberately not matched. */
const RAW_WRITER_CALL = new RegExp(`\\b${RAW_WRITER_PATTERN}\\s*\\(`);

/**
 * Every direct call to the raw container writer in `source` that sits outside
 * the two primitives. Empty means the invariant holds for this text.
 *
 * Comments are skipped — both block comments and anything after `//` on the
 * line — so a doc reference or a commented-out call is not an offender.
 */
export function findRawContainerWrites(
  source: string,
): RawContainerWriteViolation[] {
  const lines = source.split(/\r?\n/);
  const out: RawContainerWriteViolation[] = [];
  let enclosing: string | null = null;
  let inBlockComment = false;

  lines.forEach((line, index) => {
    // Track block comments first: a JSDoc paragraph mentioning the writer must
    // never be mistaken for a call.
    let scan = line;
    if (inBlockComment) {
      const end = scan.indexOf("*/");
      if (end === -1) return;
      scan = " ".repeat(end + 2) + scan.slice(end + 2);
      inBlockComment = false;
    }
    const open = scan.lastIndexOf("/*");
    if (open !== -1 && scan.indexOf("*/", open) === -1) {
      inBlockComment = true;
      scan = scan.slice(0, open);
    }

    // Attribution. A column-0 `}` closes a top-level construct, so a call after
    // it belongs to no function until the next declaration — without this, a
    // call inside a top-level `const f = () => {…}` would be misattributed to
    // whichever function happened to be declared above it.
    if (/^\}/.test(line)) enclosing = null;
    const decl = TOP_LEVEL_FN.exec(line);
    if (decl) enclosing = decl[1] ?? null;

    if (RAW_WRITER_DECL.test(line)) return;

    const match = RAW_WRITER_CALL.exec(scan);
    if (!match) return;
    // A `//` before the match means the call is inside a line comment.
    const lineComment = scan.indexOf("//");
    if (lineComment !== -1 && lineComment < match.index) return;

    if (PRIMITIVES.some((p) => p === enclosing)) return;
    out.push({ line: index + 1, enclosing, text: line.trim() });
  });

  return out;
}

/**
 * Throw if `source` contains a direct container write outside the primitives.
 *
 * `file` is used only to make the message point at a real location. The message
 * names every offender with its line, states the rule and the consequence, and
 * says what to do instead — someone who trips this should understand the
 * invariant from the failure alone, not be tempted to delete the assertion.
 */
export function assertContainerWritesRouted(
  source: string,
  file: string,
): void {
  const violations = findRawContainerWrites(source);
  if (violations.length === 0) return;
  const found = violations.map(
    (v) =>
      `  - ${file}:${v.line}` +
      (v.enclosing === null
        ? " (top level)"
        : `, inside \`${v.enclosing}()\``) +
      `\n      ${v.text}`,
  );
  throw new Error(
    [
      `Container-write invariant broken — a raw container write outside the mutation primitives.`,
      "",
      "Found:",
      ...found,
      "",
      `THE RULE: every mutation of the vaults container goes through \`${PRIMITIVES[0]}\` or`,
      `\`${PRIMITIVES[1]}\`. Each owns the container lock, the container read and the container`,
      "write, so a writer routed through one cannot skip the lock, cannot supply its own",
      "container object, and cannot persist a snapshot taken before it acquired the lock.",
      "",
      `Calling \`${RAW_WRITER}\` directly skips all of that, whether or not a lock is visibly`,
      "taken nearby. The container is stored as ONE blob, so a stale snapshot overwrites",
      "whatever landed in between — and when the vault ARRAY is what gets overwritten, what is",
      "destroyed is a vault record's wrapped VEK and sealed seed envelope, for an address that",
      "stays funded on-chain.",
      "",
      "Do NOT delete this assertion to make a new writer pass. Route the writer through a",
      "primitive. If neither can express it, that is a design change: widen a primitive",
      `deliberately and update the invariant note above \`${RAW_WRITER}\`, rather than opening a`,
      "path around them.",
      "",
      "WHAT THIS CHECK DOES NOT CATCH: it matches a direct call in source text, so indirection",
      `defeats it — aliasing (\`const write = ${RAW_WRITER}\`), dynamic dispatch, or reaching the`,
      "function from another module through the `__internalV4Multi` re-export. It narrows the",
      "gap; it does not close it.",
    ].join("\n"),
  );
}
