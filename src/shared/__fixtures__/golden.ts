// Shared golden test fixtures.
//
// These opaque on-chain values were previously restated inline in more than
// one test file. Relocating them to a single canonical source removes silent
// drift between the suites that assert the same value. They are test coverage,
// not production code — never delete them.

/** Deterministic 20-byte test wallet address. Seeds smart-account derivation
 *  in the service-worker activity + EIP-1193 suites. */
export const DETERMINISTIC_TEST_ADDRESS =
  "0xabcdef0123456789abcdef0123456789abcdef01";

/** Golden NoEvm receipt-proof `receiptsRoot` (keccak receipts-root). Asserted
 *  by the proof-verification path in the activity + MrvNative suites. */
export const NO_EVM_RECEIPT_PROOF_RECEIPTS_ROOT =
  "0x73d29f250b2f46be15d1ad19c5dc039449e5236e47c9662266ca13b71ed84928";

/** Golden NoEvm receipt-proof `targetReceiptHash` (the receipt the proof
 *  resolves to). Asserted alongside the receiptsRoot above. */
export const NO_EVM_RECEIPT_PROOF_TARGET_RECEIPT_HASH =
  "0xe4cfff110d648eb1821542b3805ded1e3df86e85b26cc19021f55168ed1a2ede";

/** `TESTNET_69420.genesis_hash` SDK-registry stub read at build-info module
 *  init. Stubbed identically by both service-worker suites. */
export const TESTNET_69420_GENESIS_HASH_STUB =
  "0xe868b8f0c671499d77d5b56404e87fc3c541c5f4777a0b1b03191a0e056f047c";

/** Canonical inner-tx hash. The hash the SW surfaces (tx-mldsa suite) and the
 *  input the Monoscan URL is built from (build-info suite). */
export const CANONICAL_INNER_TX_HASH =
  "0x36467a4360a4225ea31c348d0583e505a3d2f15b46a6d0a791163d2060e868c3";
