// SECURITY ADDENDUM — popup-side PQM-1 mnemonic generator
// for the FIRST-SETUP onboarding flow.
//
// Why generate on the popup side? The first-setup security model
// requires that NOTHING is persisted in chrome.storage until the
// user has both:
//   (1) seen the 24-word recovery phrase,
//   (2) successfully verified they wrote it down.
//
// If the popup is closed at any point between (1) and (2), the
// wallet container must stay empty so the next-open lands the user
// back on the Welcome screen — not on home with an unverified
// wallet. Previously the SW's `bgKeystoreCreateNew(password)` IPC
// generated AND persisted the vault in a single call, with the
// mnemonic returned to the popup for display. Closing the popup
// between display and verify left a fully-persisted vault behind
// with a mnemonic the user never confirmed. The verify-phrase
// step's whole purpose was bypassed.
//
// To defer persistence we hold the mnemonic + password in popup
// React state until verify-phrase completes, then call the existing
// `bgKeystoreCreateFromMnemonic(password, mnemonic)` IPC (the same
// path the Import flow uses, which already takes user-supplied
// mnemonic as input). That requires the popup to generate the
// mnemonic itself — hence this helper. The SDK's
// `generatePqm1Mnemonic` is the same primitive the SW uses; the
// entropy source is `crypto.getRandomValues` which the browser
// guarantees is CSPRNG-quality. Output bytes are identical to what
// the SW would have produced.

import { generatePqm1Mnemonic } from "@monolythium/core-sdk/crypto";

/** Generate a fresh 24-word PQM-1 recovery phrase using the
 *  browser's CSPRNG. Never persisted by this function — the caller
 *  holds the returned string in component state and commits via
 *  `bgKeystoreCreateFromMnemonic` only on verify-phrase success.
 *  Throws if the SDK rejects the entropy callback (shouldn't happen
 *  with the default 32-byte buffer). */
export function generateOnboardingMnemonic(): string {
  return generatePqm1Mnemonic((out) => {
    crypto.getRandomValues(out);
  });
}
