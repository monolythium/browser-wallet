// User-readable explanations for recovery-phrase import errors.
//
// The SDK's parsePqm1Payload / pqm1MnemonicToPayload raise typed
// `Pqm1Error`s with terse, developer-targeted messages
// ("unsupported PQM-1 algorithm tag 0x2a", "PQM-1 mnemonic must be
// 24 words, got 12"). The popup-side import flows previously
// surfaced those messages verbatim — confusing for users who have
// no context for "algorithm tag" or "PQM-1".
//
// This helper pattern-matches the raw `reason` returned by the SW
// (which is always `(e as Error).message` from the underlying SDK
// throw) and returns the user-facing string the popup should render.
// Unknown messages fall through to the original `reason` so we never
// drop information.
//
// Most common case in the wild: users importing
// the recovery phrase from the older Monolythium v1 (Cosmos) wallet,
// or from MetaMask / a Cosmos wallet. Those phrases decode to 32
// bytes of pure random entropy, so the first byte (the PQM-1 algo
// tag) is some random value other than 0x01. The SDK rejects with
// `unsupportedAlgorithm` and a hex byte — we replace that with an
// explanation users can actually act on.

export function explainImportError(reason: string): string {
  if (/already exists/i.test(reason)) {
    return "This recovery phrase is already imported on this wallet.";
  }
  if (/unsupported PQM-?1 (algorithm|algo) tag/i.test(reason)) {
    return (
      "This isn't a Monolythium v2 recovery phrase. Phrases from " +
      "other wallets — including the older Monolythium v1 wallet on " +
      "Cosmos, MetaMask, or other Cosmos wallets — use a different " +
      "format. Use a phrase generated in a Monolythium v2 wallet, or " +
      "create a new wallet."
    );
  }
  if (/unsupported PQM-?1 version/i.test(reason)) {
    return (
      "This recovery phrase uses a newer PQM-1 version this wallet " +
      "doesn't recognise yet. Try updating the wallet to the latest " +
      "release."
    );
  }
  if (/must be \d+ words/i.test(reason)) {
    return "A Monolythium recovery phrase is 24 words. Check that you've pasted all of them.";
  }
  if (/invalid PQM-?1 mnemonic|bip-?39/i.test(reason)) {
    return "Invalid recovery phrase — one or more words aren't in the BIP-39 wordlist, or the checksum is wrong. Check for typos.";
  }
  if (/PQM-?1 payload must be/i.test(reason)) {
    return "This recovery phrase decoded to an unexpected length. It may not be a Monolythium phrase.";
  }
  return reason;
}
