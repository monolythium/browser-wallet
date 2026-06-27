// User-readable explanations for recovery-phrase import errors.
//
// The SDK's mnemonicToMlDsa65Seed raises typed `MnemonicError`s with
// terse, developer-targeted messages ("mnemonic must be 24 words, got
// 12", "invalid BIP-39 mnemonic (unknown word or bad checksum)"). The
// popup-side import flows previously surfaced those messages verbatim
// — confusing for users.
//
// Recovery phrases are now plain 24-word BIP-39 (256-bit entropy,
// English wordlist); there is no self-describing header/payload to
// inspect, so the only failure modes are "wrong word count" and "not
// a valid BIP-39 phrase" (unknown word or bad checksum).
//
// This helper pattern-matches the raw `reason` returned by the SW
// (which is always `(e as Error).message` from the underlying SDK
// throw) and returns the user-facing string the popup should render.
// Unknown messages fall through to the original `reason` so we never
// drop information.

export function explainImportError(reason: string): string {
  if (/already exists/i.test(reason)) {
    return "This recovery phrase is already imported on this wallet.";
  }
  if (/must be \d+ words/i.test(reason)) {
    return "A Monolythium recovery phrase is 24 words. Check that you've pasted all of them.";
  }
  if (/invalid bip-?39|unknown word|checksum/i.test(reason)) {
    return "Invalid recovery phrase — one or more words aren't in the BIP-39 wordlist, or the checksum is wrong. Check for typos.";
  }
  return reason;
}
