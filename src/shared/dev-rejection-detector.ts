// Dev-build detector for unhandled promise rejections.
//
// THIS IS A DETECTOR, NOT A HANDLER. It exists so the NEXT missing `catch` is
// noticed while someone is working, instead of surviving until an audit finds
// it. It deliberately does not:
//
//   - render anything user-facing,
//   - call `preventDefault()`, or otherwise suppress or swallow the rejection,
//   - make a surface look handled when it is not.
//
// A surface that trips this is still broken. The fix is a `catch` at the call
// site that renders the failure, exactly as the Names / SLH-DSA / native-multisig
// surfaces now do. Nothing here substitutes for that, and nothing here should
// ever grow into a global error banner: a generic "something went wrong" would
// leave the offending control stuck in its busy state anyway, because this code
// has no access to the component that owns it.
//
// WHY IT IS NEEDED: React error boundaries catch render and lifecycle throws and
// never async rejections, so a `void handler()` whose promise rejects reaches the
// devtools console and nowhere else. That is how three silent value-path failures
// survived to an audit.
//
// ── What it logs, and why that is safe ──────────────────────────────────────
//
// It NEVER reads the rejection's payload value. A rejection reason is arbitrary
// and may carry anything a caller put in it — a password, a mnemonic, key
// material, a signed transaction. So the diagnostic is built from two bounded
// things only:
//
//   1. A TYPE NAME (`TypeError`, `Object`, `string`) — a constructor or `typeof`
//      result, never a value.
//   2. STACK FRAMES ONLY — the `at …` lines, which carry file, function and
//      position. V8 puts the error MESSAGE on the first line of `.stack`, and
//      that line is the one place an interpolated secret could appear, so it is
//      filtered out rather than truncated. Truncating a secret still leaks one.
//
// Dropping the message costs nothing: the browser reports the full rejection to
// the same console on its own, and this detector deliberately does not suppress
// that. The browser's line is the detail; this one is the attention-getter that
// says a surface is missing a `catch`.

import { isHardenedBuild } from "./build-mode.js";

/** Frame cap — enough to identify the call site, short enough to stay readable
 *  when several rejections land together. */
const MAX_FRAMES = 6;

/** Build the payload-free diagnostic body for a rejection reason.
 *
 *  Pure and exported so the safety property is testable without a DOM: given a
 *  reason whose message contains a secret, the output must not contain it. */
export function formatRejectionDiagnostic(reason: unknown): string {
  const lines = [`type: ${describeKind(reason)}`, ...describeFrames(reason)];
  return lines.map((l) => `  ${l}`).join("\n");
}

/** A constructor or `typeof` name — never a value. */
function describeKind(reason: unknown): string {
  if (reason instanceof Error) return reason.name;
  if (reason === null) return "null";
  const kind = typeof reason;
  if (kind !== "object") return kind;
  // `Object.create(null)` has no constructor; a hostile/exotic object could have
  // a non-function one. Both fall back rather than reading anything off it.
  const ctor = (reason as { constructor?: unknown }).constructor;
  if (typeof ctor === "function" && typeof ctor.name === "string" && ctor.name.length > 0) {
    return ctor.name;
  }
  return "object";
}

/** The `at …` frames of an Error's stack, capped. Everything else — including
 *  V8's leading "<Name>: <message>" line — is dropped.
 *
 *  The filter is the security boundary, so it fails CLOSED: on an engine whose
 *  stack format doesn't match (V8 is the only one a Chrome extension runs on),
 *  nothing matches and nothing is emitted, rather than falling back to raw text. */
function describeFrames(reason: unknown): string[] {
  if (!(reason instanceof Error)) return [];
  const stack = reason.stack;
  if (typeof stack !== "string") return [];
  return stack
    .split("\n")
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
}

let armed = false;
let seen = 0;

/** Register the detector. No-op in a hardened (production) build, so it can
 *  never reach a shipped extension, and no-op if called twice.
 *
 *  Build-gated rather than gated on the DEVELOPER_MODE preference on purpose: a
 *  user who turns developer mode on is exploring wallet features, not debugging
 *  async plumbing, and stack frames are developer output. Build-gating is also
 *  the stronger property — the code path does not exist in a release build at
 *  all, instead of existing behind a flag a user can flip. */
export function armUnhandledRejectionDetector(): void {
  if (isHardenedBuild() || armed) return;
  // Same call in a window and in a service worker; `globalThis` covers both.
  const target = globalThis as unknown as {
    addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  };
  if (typeof target.addEventListener !== "function") return;
  armed = true;
  target.addEventListener("unhandledrejection", (event: unknown) => {
    seen += 1;
    const reason = (event as { reason?: unknown }).reason;
    // NOTE: no `preventDefault()`. Suppressing the event would hide the
    // browser's own full report, which is the detail this line points at.
    console.warn(
      `[wallet:dev] unhandled promise rejection #${seen} — DETECTED, NOT HANDLED.\n` +
        `${formatRejectionDiagnostic(reason)}\n` +
        `  A surface awaited a rejecting promise without a catch, so the user was\n` +
        `  shown nothing. Fix it at the call site; this detector only reports.\n` +
        `  Payload not read (it can hold secrets) — see the browser's own report.`,
    );
  });
}
