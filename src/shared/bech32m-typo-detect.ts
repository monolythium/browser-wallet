// Phase 11 Commit 7 — bech32m typo detection.
//
// A user copying a `mono1...` address from a chat or QR can introduce
// a single-character typo. The full address fails bech32m checksum
// (cubic-spline failure rate is excellent), but the user just sees a
// generic "invalid checksum" error and may not know what to fix.
//
// This module looks for an obvious 1-edit-distance correction: try
// substituting one position with every other valid bech32m character
// and report the FIRST candidate that passes checksum. Returning the
// first match is deliberate — if two valid candidates exist (highly
// unlikely for a 41-char address) we don't want to guess.
//
// Returns null when no 1-edit fix exists. Don't try edit-distance > 1;
// the false-positive rate would surface incorrect addresses to users,
// which is far more dangerous than no suggestion at all.

import { tryDecodeBech32m } from "./bech32m.js";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const MONO_HRP = "mono1";

/** Try to find a single-character substitution that produces a
 *  bech32m-checksum-valid address. Returns the candidate string when
 *  one exists, null otherwise.
 *
 *  Cost bounds: scans at most (length - hrp.length) × 31 substitutions.
 *  For a 39-character `mono1...` payload that's ~34 × 31 ≈ 1054 checksum
 *  attempts. Each checksum is O(n) over the address, so ~40k char ops
 *  total — runs well under 10 ms on commodity hardware. */
export function suggestBech32mCorrection(input: string): string | null {
  const normalised = input.trim().toLowerCase();
  if (!normalised.startsWith(MONO_HRP)) return null;
  // Only attempt suggestions for plausibly-shaped inputs. mono1 + 38
  // chars is the canonical length for a 20-byte address. Reject if
  // the length is far from the canonical (38 + 5 = 43).
  if (normalised.length < 30 || normalised.length > 70) return null;
  // Skip if the original is already valid.
  if (isBech32mValid(normalised)) return null;

  // Walk every position in the payload (after the hrp1 prefix) and
  // try each of the 32 valid charset chars. Return the first that
  // produces a valid checksum.
  for (let pos = MONO_HRP.length; pos < normalised.length; pos++) {
    const original = normalised.charAt(pos);
    for (const c of BECH32_CHARSET) {
      if (c === original) continue;
      const candidate =
        normalised.slice(0, pos) + c + normalised.slice(pos + 1);
      if (isBech32mValid(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

/** Return true when the input passes bech32m decode with hrp `mono`. */
function isBech32mValid(input: string): boolean {
  const decoded = tryDecodeBech32m(input);
  return decoded !== null && decoded.hrp === "mono";
}

/** Classify what the user has typed. Used by the Send page to choose
 *  the right inline hint:
 *    - "bech32m-valid"     → ready to use, no hint
 *    - "bech32m-typo"      → bech32m-shaped but failed checksum, with
 *                             a 1-edit candidate (when findable)
 *    - "bech32m-malformed" → bech32m-shaped but no 1-edit fix found
 *    - "hex"               → retired raw 0x address; do not suggest typos
 *    - "empty"             → nothing typed yet
 *    - "unknown"           → not recognisable
 *
 *  The shape check is intentionally permissive — we want to surface
 *  hints even before the user finishes typing, so the user can fix
 *  things as they go. */
export type AddressInputKind =
  | { kind: "empty" }
  | { kind: "bech32m-valid"; decoded: string }
  | { kind: "bech32m-typo"; suggestion: string }
  | { kind: "bech32m-malformed" }
  | { kind: "hex"; address: string }
  | { kind: "unknown" };

export function classifyAddressInput(raw: string): AddressInputKind {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  const lower = trimmed.toLowerCase();
  // Hex address?
  if (/^0x[0-9a-f]{40}$/i.test(trimmed)) {
    return { kind: "hex", address: trimmed };
  }
  // Bech32m-shaped?
  if (lower.startsWith(MONO_HRP)) {
    if (isBech32mValid(lower)) {
      return { kind: "bech32m-valid", decoded: lower };
    }
    const suggestion = suggestBech32mCorrection(lower);
    if (suggestion !== null) {
      return { kind: "bech32m-typo", suggestion };
    }
    return { kind: "bech32m-malformed" };
  }
  return { kind: "unknown" };
}
