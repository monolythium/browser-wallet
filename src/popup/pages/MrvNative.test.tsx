import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MrvNative,
  NativeMarketReplayReadinessCard,
  MrvNativePlanPreview,
  buildMrvNativeRequest,
  coerceHexQuantityInput,
  type MrvNativeFormValues,
  type NativeMarketReplayReadinessState,
} from "./MrvNative.js";
import type {
  WalletMrvNoEvmFinalityEvidence,
  WalletMrvNoEvmFinalityVerification,
  WalletMrvNoEvmCompactReceiptProofTranscript,
  WalletMrvNativeSubmissionPlan,
  WalletMrvNoEvmReceiptProofTranscript,
  WalletMrvNoEvmReceiptProofVerification,
} from "../bg.js";

const BASE_FORM: MrvNativeFormValues = {
  artifactBytes: "0x13000000",
  artifactHash: "",
  contractAddress: "0x2222222222222222222222222222222222222222",
  callInput: "0xaabbccdd",
  executionUnitLimit: "2097152",
  maxExecutionFeeLythoshi: "10000000",
  priorityTipLythoshi: "",
  valueLythoshi: "42",
};

const SUBMITTED_TX_HASH = `0x${"a".repeat(64)}`;
const RECEIPT_COMMITMENT = `0x${"c".repeat(64)}`;
const ARCHIVE_SIGNATURE_DIGEST = `0x${"e".repeat(64)}`;
const ARCHIVE_COVERING_SNAPSHOT = {
  snapshotHeight: 101,
  manifestHash: `0x${"a".repeat(64)}`,
  signatureDigest: `0x${"b".repeat(64)}`,
  contentHash: `0x${"c".repeat(64)}`,
  checkpointContentHash: `0x${"9".repeat(64)}`,
  checkpointFrom: 0,
  checkpointTo: 101,
  signatures: [`mono.snapshot.sig.v1:0x${"d".repeat(40)}:0x1234abcd`],
};
const MISSING_FINALITY_PROOF_MATERIAL =
  "BLS aggregate finality certificate for block round";
const NO_EVM_FINALITY_EVIDENCE: WalletMrvNoEvmFinalityEvidence = {
  schema: "mono.no_evm_receipt_finality.v1",
  source: "blsRoundCertificate",
  round: 57,
  certificate: {
    round: 57,
    signature: "0x1234",
    signersBitmap: "0xabcd",
    signerIndices: [1, 3],
    signerCount: 2,
  },
};
const NO_EVM_RECEIPT_PROOF: WalletMrvNoEvmReceiptProofTranscript = {
  schema: "mono.no_evm_receipt_proof.v1",
  proofKind: "boundedCacheTranscript",
  proofType: "canonicalReceiptsTranscript",
  historySource: "liveBlockCache",
  compactInclusionProof: null,
  archiveProof: null,
  finalityEvidence: null,
  missingProofMaterial: [MISSING_FINALITY_PROOF_MATERIAL],
  rootAlgorithm: "keccak256(monolythium/v2/receipts_root/1)",
  receiptCodec: "rlp-eth-receipt",
  blockHash: `0x${"1".repeat(64)}`,
  txHash: SUBMITTED_TX_HASH,
  receiptsRoot:
    "0x73d29f250b2f46be15d1ad19c5dc039449e5236e47c9662266ca13b71ed84928",
  targetReceiptHash:
    "0xe4cfff110d648eb1821542b3805ded1e3df86e85b26cc19021f55168ed1a2ede",
  blockHeight: 100,
  txIndex: 1,
  receiptCount: 2,
  receiptTranscript: ["0x01", "0x02ff"],
  targetReceiptBytes: null,
};
const NO_EVM_RECEIPT_PROOF_VERIFICATION: WalletMrvNoEvmReceiptProofVerification = {
  status: "verified",
  proofKind: "boundedCacheTranscript",
  receiptCountMatches: true,
  receiptsRootMatches: true,
  targetReceiptHashMatches: true,
  receiptCount: 2,
  transcriptCount: 2,
  computedReceiptsRoot: NO_EVM_RECEIPT_PROOF.receiptsRoot,
  computedTargetReceiptHash: NO_EVM_RECEIPT_PROOF.targetReceiptHash,
};
const NO_EVM_FINALITY_VERIFICATION_UNCONFIGURED: WalletMrvNoEvmFinalityVerification = {
  status: "unverified",
  reason: "trusted BLS finality config not configured",
  details: null,
};
const NO_EVM_FINALITY_VERIFICATION_VERIFIED: WalletMrvNoEvmFinalityVerification = {
  status: "verified",
  reason: null,
  details: {
    finalityEvidencePresent: true,
    signerCountMatches: true,
    signerBitmapMatchesIndices: true,
    signerIndicesInRange: true,
    allSignersTrusted: true,
    thresholdMet: true,
    signatureValid: true,
    acceptedSignatureCount: 2,
    requiredSignatureCount: 2,
    verified: true,
  },
};
const NO_EVM_FINALITY_VERIFICATION_MISMATCH: WalletMrvNoEvmFinalityVerification = {
  status: "mismatch",
  reason: "BLS finality evidence did not verify against configured trust inputs",
  details: {
    ...NO_EVM_FINALITY_VERIFICATION_VERIFIED.details!,
    signatureValid: false,
    verified: false,
  },
};
const INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF: WalletMrvNoEvmCompactReceiptProofTranscript = {
  schema: "mono.no_evm_receipt_proof.v1",
  proofKind: "compactInclusion",
  proofType: "canonicalReceiptInclusion",
  historySource: "indexerReceiptArchive",
  compactInclusionProof: {
    schema: "mono.no_evm_receipt_compact_inclusion.v1",
    treeAlgorithm: "binary-keccak-receipt-tree",
    root: `0x${"7".repeat(64)}`,
    leafHash: `0x${"7".repeat(64)}`,
    siblingHashes: [],
    pathSides: [],
  },
  archiveProof: {
    schema: "mono.no_evm_receipt_archive_binding.v1",
    source: "indexerReceiptArchiveContentDigest",
    manifestHash: `0x${"6".repeat(64)}`,
    contentHash: `0x${"9".repeat(64)}`,
    signatures: [],
  },
  finalityEvidence: NO_EVM_FINALITY_EVIDENCE,
  missingProofMaterial: [],
  rootAlgorithm:
    "keccak256-binary-merkle(monolythium/v4.1/receipt_leaf/1, monolythium/v4.1/receipt_node/1, duplicate-last padding)",
  receiptCodec: "bincode(protocore_evm::Receipt)",
  blockHash: `0x${"2".repeat(64)}`,
  txHash: SUBMITTED_TX_HASH,
  receiptsRoot: `0x${"7".repeat(64)}`,
  targetReceiptHash: `0x${"8".repeat(64)}`,
  blockHeight: 101,
  txIndex: 0,
  receiptCount: 1,
  receiptTranscript: [],
  targetReceiptBytes: "0x04050607",
};
const INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION: WalletMrvNoEvmReceiptProofVerification = {
  status: "verified",
  proofKind: "compactInclusion",
  receiptCountMatches: true,
  receiptsRootMatches: true,
  targetReceiptHashMatches: true,
  compactLeafHashMatches: true,
  compactPathMatches: true,
  receiptCount: 1,
  transcriptCount: 0,
  computedReceiptsRoot: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.receiptsRoot,
  computedTargetReceiptHash:
    INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.targetReceiptHash,
  computedCompactLeafHash:
    INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.compactInclusionProof.leafHash,
};
const MARKET_ID = `0x${"a".repeat(64)}`;
const ORDER_ID = `0x${"b".repeat(64)}`;

function buildDeployPlan(): WalletMrvNativeSubmissionPlan {
  return {
    kind: "mrv_deploy",
    request: {
      from: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
      artifactBytes: "0x13000000",
      valueLythoshi: "0",
      executionUnitLimit: "1000000",
      maxExecutionFeeLythoshi: "100",
      priorityTipLythoshi: "1",
      nonce: "7",
    },
    extension: { kind: 48, bodyHex: "0x01" },
    expectedContractAddress: "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd",
    nativeTx: {
      chainId: "69420",
      nonce: "7",
      valueLythoshi: "0",
      executionUnitLimit: "1000000",
      maxExecutionFeeLythoshi: "100",
      priorityTipLythoshi: "1",
    },
    feePreview: {
      totalLythoshi: "100",
      totalLyth: "0.000001",
      cyclesUsed: "1000000",
      executionUnitLimit: "1000000",
      maxExecutionFeeLythoshi: "100",
      priorityTipLythoshi: "1",
    },
    tx: {
      chainIdHex: "0x10f2c",
      nonceHex: "0x7",
      gasLimitHex: "0xf4240",
      maxFeePerGas: "0x64",
      maxPriorityFeePerGas: "0x1",
      to: null,
      valueWeiHex: "0x0",
      data: "0x13000000",
      extensions: [{ kind: 48, bodyHex: "0x01" }],
    },
  };
}

describe("MrvNative", () => {
  it("renders the v4.1 MRV native preview and honest submit scope", () => {
    const html = renderToStaticMarkup(
      <MrvNative chainIdHex="0x10F2C" onBack={() => undefined} />,
    );

    expect(html).toContain("MRV native");
    expect(html).toContain("Native contract preview");
    expect(html).toContain("execution units");
    expect(html).toContain("lythoshi");
    expect(html).toContain("typed addresses");
    expect(html).toContain("polls transaction receipt inclusion status");
    expect(html).toContain("does not prove live MRV execution");
    expect(html).toContain("Native market replay");
    expect(html).toContain("Checking recent orderbook replay status");
  });

  it("renders native market replay readiness from returned deltas only", () => {
    const state: NativeMarketReplayReadinessState = {
      phase: "ready",
      fromBlock: 100,
      toBlock: 228,
      operator: "operator-test",
      outcome: {
        kind: "live",
        via: "/api/v1/native-market-orderbook-deltas",
        durationMs: 12,
        data: {
          schemaVersion: 1,
          fromBlock: 100,
          toBlock: 228,
          limit: 5,
          cursor: null,
          nextCursor: null,
          filters: {},
          replay: true,
          streamTopic: "nativeMarketOrderBook",
          source: {
            indexerProvider: "native_events",
            projection: "native_market_orderbook_deltas",
          },
          deltas: [
            {
              marketId: MARKET_ID,
              orderId: ORDER_ID,
              eventName: "market.spot.order_placed",
              action: "upsert",
              side: "bid",
              price: "101",
              quantity: "9",
              remaining: "7",
              status: "open",
              blockHeight: 120,
              txIndex: 0,
              logIndex: 1,
            },
          ],
        },
      },
    };

    const html = renderToStaticMarkup(
      <NativeMarketReplayReadinessCard state={state} />,
    );

    expect(html).toContain("Replay endpoint live");
    expect(html).toContain("blocks 100-228");
    expect(html).toContain("operator operator-test");
    expect(html).toContain("Rows returned 1");
    expect(html).toContain("source native_events/native_market_orderbook_deltas");
    expect(html).toContain("upsert");
    expect(html).toContain("market.spot.order_placed");
    expect(html).toContain("bid 101 @ 7");
    expect(html).toContain("0xaaaaaaaa");
    expect(html).toContain("0xbbbbbbbb");
  });

  it("renders native market replay fallback states without fabricated rows", () => {
    const state: NativeMarketReplayReadinessState = {
      phase: "ready",
      fromBlock: 100,
      toBlock: 228,
      operator: null,
      outcome: {
        kind: "mock-not-deployed",
        via: "mock",
        durationMs: 5,
        reason: "/api/v1/native-market-orderbook-deltas: HTTP 404",
        data: null,
      },
    };

    const html = renderToStaticMarkup(
      <NativeMarketReplayReadinessCard state={state} />,
    );

    expect(html).toContain("Replay endpoint not deployed");
    expect(html).toContain("operator unknown");
    expect(html).toContain("No market rows shown from fallback data");
    expect(html).toContain("/api/v1/native-market-orderbook-deltas: HTTP 404");
    expect(html).not.toContain("Rows returned");
    expect(html).not.toContain("market.spot.order_placed");
  });

  it("renders returned JSON-safe plans with native contract and fee terms", () => {
    const plan: WalletMrvNativeSubmissionPlan = {
      kind: "mrv_call",
      request: {
        from: "mono1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg357f9at",
        contractAddress: "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd",
        input: "0xaabbccdd",
        valueLythoshi: "42",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
        nonce: "8",
      },
      extension: { kind: 1, bodyHex: "0x02aabbccdd" },
      nativeTx: {
        chainId: "69420",
        nonce: "8",
        valueLythoshi: "42",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
      },
      feePreview: {
        totalLythoshi: "20971520000042",
        totalLyth: "209715.20000042",
        cyclesUsed: "2097152",
        executionUnitLimit: "2097152",
        maxExecutionFeeLythoshi: "10000000",
        priorityTipLythoshi: "5",
      },
      tx: {
        chainIdHex: "0x10f2c",
        nonceHex: "0x8",
        gasLimitHex: "0x200000",
        maxFeePerGas: "0x989680",
        maxPriorityFeePerGas: "0x5",
        to: "0x2222222222222222222222222222222222222222",
        valueWeiHex: "0x2a",
        data: "0xaabbccdd",
        extensions: [{ kind: 1, bodyHex: "0x02aabbccdd" }],
      },
    };

    const html = renderToStaticMarkup(<MrvNativePlanPreview plan={plan} />);

    expect(html).toContain("Native contract");
    expect(html).toContain("Typed user address");
    expect(html).toContain("2097152");
    expect(html).toContain("10000000 lythoshi");
    expect(html).toContain("JSON-safe plan");
    expect(html).toContain("monoc1yg3");
  });

  it("renders a submit-ready preview action without claiming confirmation", () => {
    const plan = buildDeployPlan();

    const readyHtml = renderToStaticMarkup(
      <MrvNativePlanPreview plan={plan} onSubmit={() => undefined} />,
    );
    expect(readyHtml).toContain("Sign and submit");

    const html = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
      />,
    );

    expect(html).toContain("Transaction submitted");
    expect(html).toContain("mock-operator");
    expect(html).toContain("Receipt polling checks transaction inclusion");
    expect(html).toContain("transcript self-check runs after native evidence");
  });

  it("renders MRV receipt polling, included, and unavailable states honestly", () => {
    const plan = buildDeployPlan();
    const pollingHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{ phase: "polling", via: "mock-operator" }}
      />,
    );
    expect(pollingHtml).toContain("Receipt status: waiting for inclusion");
    expect(pollingHtml).toContain("eth_getTransactionReceipt");
    expect(pollingHtml).toContain("Validator finality is not established here");

    const includedHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          via: "mock-operator",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x64",
            contractAddress: "0x2222222222222222222222222222222222222222",
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: null,
              noEvmProofStatus: "missing",
              noEvmProofVerification: null,
              noEvmFinalityVerification: null,
            },
          },
        }}
      />,
    );
    expect(includedHtml).toContain("Receipt status: included");
    expect(includedHtml).toContain("block 100");
    expect(includedHtml).toContain("Contract 0x222222");
    expect(includedHtml).toContain("Native receipt riscv.receipt.v1");
    expect(includedHtml).toContain("Receipt commitment evidence");
    expect(includedHtml).toContain(RECEIPT_COMMITMENT);
    expect(includedHtml).toContain(
      "returned no no-EVM receipt-proof transcript payload",
    );

    const proofHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x64",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: NO_EVM_RECEIPT_PROOF,
              noEvmProofStatus: "transcript-verified",
              noEvmProofVerification: NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification: null,
            },
          },
        }}
      />,
    );
    expect(proofHtml).toContain("No-EVM receipt-proof transcript present");
    expect(proofHtml).toContain("bounded receipt evidence only");
    expect(proofHtml).toContain("Transcript self-check verified");
    expect(proofHtml).toContain("canonicalReceiptsTranscript");
    expect(proofHtml).toContain("keccak256(monolythium/v2/receipts_root/1)");
    expect(proofHtml).toContain("txIndex 1");
    expect(proofHtml).toContain("transcript blobs 2");
    expect(proofHtml).toContain("Finality evidence: absent");
    expect(proofHtml).toContain(MISSING_FINALITY_PROOF_MATERIAL);
    expect(proofHtml).toContain("Count check");
    expect(proofHtml).toContain("Root check");
    expect(proofHtml).toContain(NO_EVM_RECEIPT_PROOF.receiptsRoot);

    const compactArchiveHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x65",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
              noEvmProofStatus: "proof-verified",
              noEvmProofVerification:
                INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification:
                NO_EVM_FINALITY_VERIFICATION_UNCONFIGURED,
            },
          },
        }}
      />,
    );
    expect(compactArchiveHtml).toContain("No-EVM compact inclusion proof");
    expect(compactArchiveHtml).toContain("indexer receipt archive");
    expect(compactArchiveHtml).toContain("indexer receipt archive content digest");
    expect(compactArchiveHtml).toContain("Archive signatures absent");
    expect(compactArchiveHtml).not.toContain("Archive signature digest");
    expect(compactArchiveHtml).toContain("BLS round certificate");
    expect(compactArchiveHtml).toContain("round 57");
    expect(compactArchiveHtml).toContain("signer count 2");
    expect(compactArchiveHtml).toContain("0x1234");
    expect(compactArchiveHtml).toContain("1, 3");
    expect(compactArchiveHtml).toContain("0xabcd");
    expect(compactArchiveHtml).toContain(
      "BLS round certificate parsed, not wallet-verified",
    );
    expect(compactArchiveHtml).toContain(
      "Wallet BLS check: trusted BLS finality config not configured",
    );
    expect(compactArchiveHtml).toContain(
      "wallet-side BLS finality verification is not configured here",
    );
    expect(compactArchiveHtml).toContain("Compact inclusion self-check verified");
    expect(compactArchiveHtml).toContain("target-only receipt evidence");
    expect(compactArchiveHtml).toContain("canonicalReceiptInclusion");
    expect(compactArchiveHtml).toContain("target bytes 4");
    expect(compactArchiveHtml).toContain("Index check");
    expect(compactArchiveHtml).toContain("Leaf check");
    expect(compactArchiveHtml).toContain("Path check");

    const verifiedFinalityHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x65",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
              noEvmProofStatus: "proof-verified",
              noEvmProofVerification:
                INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification: NO_EVM_FINALITY_VERIFICATION_VERIFIED,
            },
          },
        }}
      />,
    );
    expect(verifiedFinalityHtml).toContain(
      "wallet-verified BLS round certificate",
    );
    expect(verifiedFinalityHtml).toContain("BLS threshold check");
    expect(verifiedFinalityHtml).toContain("2/2 signatures · signature valid");
    expect(verifiedFinalityHtml).toContain(
      "wallet-side BLS finality verification is shown",
    );

    const mismatchFinalityHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x65",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
              noEvmProofStatus: "proof-verified",
              noEvmProofVerification:
                INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification: NO_EVM_FINALITY_VERIFICATION_MISMATCH,
            },
          },
        }}
      />,
    );
    expect(mismatchFinalityHtml).toContain(
      "BLS round certificate verification mismatch",
    );
    expect(mismatchFinalityHtml).toContain(
      "Wallet BLS check: BLS finality evidence did not verify against configured trust inputs",
    );
    expect(mismatchFinalityHtml).toContain("2/2 signatures · signature invalid");
    expect(mismatchFinalityHtml).toContain(
      "wallet-side BLS finality verification did not pass",
    );

    const digestArchiveProof: WalletMrvNoEvmCompactReceiptProofTranscript = {
      ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
      archiveProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof!,
        signatureDigest: ARCHIVE_SIGNATURE_DIGEST,
      },
    };
    const digestArchiveHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x65",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: digestArchiveProof,
              noEvmProofStatus: "proof-verified",
              noEvmProofVerification:
                INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification:
                NO_EVM_FINALITY_VERIFICATION_UNCONFIGURED,
            },
          },
        }}
      />,
    );
    expect(digestArchiveHtml).toContain(
      "Snapshot archive signature digest material is present",
    );
    expect(digestArchiveHtml).toContain(
      "not validator finality or wallet-side cryptographic verification",
    );
    expect(digestArchiveHtml).toContain("Archive signature digest");
    expect(digestArchiveHtml).toContain(ARCHIVE_SIGNATURE_DIGEST);

    const coveringSnapshotProof: WalletMrvNoEvmCompactReceiptProofTranscript = {
      ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF,
      archiveProof: {
        ...INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF.archiveProof!,
        coveringSnapshot: ARCHIVE_COVERING_SNAPSHOT,
      },
    };
    const coveringSnapshotHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x65",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: coveringSnapshotProof,
              noEvmProofStatus: "proof-verified",
              noEvmProofVerification:
                INDEXER_ARCHIVE_COMPACT_NO_EVM_RECEIPT_PROOF_VERIFICATION,
              noEvmFinalityVerification:
                NO_EVM_FINALITY_VERIFICATION_UNCONFIGURED,
            },
          },
        }}
      />,
    );
    expect(coveringSnapshotHtml).toContain("Covering snapshot parsed");
    expect(coveringSnapshotHtml).toContain(
      "wallet has not cryptographically verified these archive signatures",
    );
    expect(coveringSnapshotHtml).toContain("Snapshot height 101");
    expect(coveringSnapshotHtml).toContain("checkpoint 0-101");
    expect(coveringSnapshotHtml).toContain("Snapshot manifest");
    expect(coveringSnapshotHtml).toContain("Snapshot signature digest");
    expect(coveringSnapshotHtml).toContain("Snapshot content");
    expect(coveringSnapshotHtml).toContain("Checkpoint content");
    expect(coveringSnapshotHtml).toContain(ARCHIVE_COVERING_SNAPSHOT.manifestHash);
    expect(coveringSnapshotHtml).toContain(
      ARCHIVE_COVERING_SNAPSHOT.checkpointContentHash,
    );

    const mismatchRoot = `0x${"4".repeat(64)}`;
    const mismatchHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "included",
          receipt: {
            txHash: SUBMITTED_TX_HASH,
            status: "0x1",
            blockNumber: "0x64",
            contractAddress: null,
            nativeReceipt: {
              schema: "riscv.receipt.v1",
              txType: 0x41,
              artifactHash: "0x" + "b".repeat(64),
              receiptCommitment: RECEIPT_COMMITMENT,
              eventCount: 1,
              noEvmProof: {
                ...NO_EVM_RECEIPT_PROOF,
                receiptsRoot: mismatchRoot,
              },
              noEvmProofStatus: "transcript-mismatch",
              noEvmProofVerification: {
                ...NO_EVM_RECEIPT_PROOF_VERIFICATION,
                status: "mismatch",
                receiptsRootMatches: false,
              },
              noEvmFinalityVerification: null,
            },
          },
        }}
      />,
    );
    expect(mismatchHtml).toContain("Transcript self-check mismatch");
    expect(mismatchHtml).toContain("Computed root");
    expect(mismatchHtml).toContain(NO_EVM_RECEIPT_PROOF.receiptsRoot);
    expect(mismatchHtml).toContain(mismatchRoot);

    const unavailableHtml = renderToStaticMarkup(
      <MrvNativePlanPreview
        plan={plan}
        onSubmit={() => undefined}
        submitResult={{ txHash: SUBMITTED_TX_HASH, via: "mock-operator" }}
        receiptState={{
          phase: "unavailable",
          reason: "method not found",
          method: "eth_getTransactionReceipt",
          code: -32601,
        }}
      />,
    );
    expect(unavailableHtml).toContain("Receipt polling unavailable");
    expect(unavailableHtml).toContain("method not found");
    expect(unavailableHtml).toContain("RPC eth_getTransactionReceipt");
  });
});

describe("buildMrvNativeRequest", () => {
  it("builds deploy payloads with canonical execution-unit and lythoshi quantities", () => {
    const req = buildMrvNativeRequest("deploy", BASE_FORM, "0x10F2C");

    expect(req).toEqual({
      ok: true,
      mode: "deploy",
      args: {
        artifactBytes: "0x13000000",
        chainIdHex: "0x10f2c",
        executionUnitLimitHex: "0x200000",
        maxExecutionFeeLythoshiHex: "0x989680",
        valueWeiHex: "0x2a",
      },
    });
  });

  it("builds call payloads for native contract typed-address normalization in the background", () => {
    const req = buildMrvNativeRequest("call", BASE_FORM, "0x10F2C");

    expect(req).toEqual({
      ok: true,
      mode: "call",
      args: {
        contractAddress: "0x2222222222222222222222222222222222222222",
        input: "0xaabbccdd",
        chainIdHex: "0x10f2c",
        executionUnitLimitHex: "0x200000",
        maxExecutionFeeLythoshiHex: "0x989680",
        valueWeiHex: "0x2a",
      },
    });
  });

  it("rejects missing deploy artifact bytes before IPC", () => {
    const req = buildMrvNativeRequest(
      "deploy",
      { ...BASE_FORM, artifactBytes: "" },
      "0x10F2C",
    );

    expect(req).toEqual({ ok: false, reason: "artifact bytes is required" });
  });
});

describe("coerceHexQuantityInput", () => {
  it("accepts decimal or 0x input and emits canonical lowercase hex quantities", () => {
    expect(
      coerceHexQuantityInput("1000000", "execution unit limit", {
        required: true,
        allowZero: false,
      }),
    ).toEqual({ ok: true, value: "0xf4240" });
    expect(
      coerceHexQuantityInput("0x000F", "priority tip lythoshi", {
        required: false,
        allowZero: true,
      }),
    ).toEqual({ ok: true, value: "0xf" });
  });

  it("rejects fractional lythoshi values", () => {
    expect(
      coerceHexQuantityInput("1.5", "value lythoshi", {
        required: false,
        allowZero: true,
      }),
    ).toEqual({
      ok: false,
      reason: "value lythoshi must be a non-negative integer or 0x hex quantity",
    });
  });
});
