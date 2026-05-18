# Chain Sync Log

Running log of when browser-wallet baselined against `mono-core` + `mono-core-sdk` upstream. Latest entry first.

## 2026-05-18T17:00Z — Phase 11.6 sync + genesis-disable

**Branch**: `feat/phase-11.6-resync-and-genesis-disable`
**Wallet base**: master HEAD `a2d692d` (Phase 11.5 audit follow-ups)

**mono-core**: `dd05511` → `c787f44` (+166 commits)
**mono-core-sdk**: `0fd8a79` → `ffeb897` (+3 commits, **0 bytes `packages/ts/src/` diff** — packaging only: `private:false`, expose at repo root, prebuilt dist)

### Window split (mono-core)

The upstream window divides cleanly at tag `pre-v4.1-rollback-20260517T224807Z`:

- **79 pre-v4.1 commits** (deployable to current Sprintnet): warm-restart hardening, dag-sync internals, AUD-XXXX evidence verification, Storage Box release tooling, public-proposer / runtime quarantine gates, Ferveo bundle tooling (deploy still pending), and one wallet-affecting commit (`3537b135`).
- **87 v4.1 commits** (NOT YET deployed to Sprintnet): the V1 scope reset (`04806853`) records four breaking ADRs — ADR-0037 (8-decimal LYTH / lythoshi atomic), ADR-0038 (BLAKE3-20 addresses + typed bech32m HRP), ADR-0039 (one-LYTH-number fee display), ADR-0040 (third-party bridges only, consensus-enforced floors). Plus MRV / RISC-V native execution layer, MRC-20/721/1155/4626 module bases, native event/receipt indexer, address derivation cutover to BLAKE3.

### Question answers (Phase 11.6 investigation matrix)

| # | Question | Answer | Action |
|---|----------|--------|--------|
| 1 | Ferveo deploy in upstream? | PARTIAL — tooling shipped (`5bf1b55a`, `814de034`, `fbb5c21b`); deploy still gated (V1-scope-reset commit explicitly tracks "2026-05-17 Ferveo deploy-gate note for the browser-wallet 6-operator subset on chain_id 69420") | none (no operator binary rollout) |
| 2 | Plain ML-DSA submit RPC? | NO | none |
| 3 | Indexer schema version? | Unchanged at v4 (`3537b135` only added the sentinel constant; SCHEMA_VERSION untouched) | none |
| 4 | `lyth_clusterApr` exposed? | NO | none |
| 5 | `lyth_pendingRewards` exposed? | NO | none |
| 6 | §22.8 namingRegistry reader? | NO | none |
| 7 | `lyth_setAddressLabel` write-mode? | NO | none |
| 8 | WSS endpoints exposed? | No commit-detectable signal (operator-side) | none |
| 9 | `lyth_resolveOperatorAuthority`? | NO | none |
| 10 | `3537b135` native-LYTH zero-hash sentinel in HEAD? | YES (in pre-v4.1 window) | **Commit 2** (defensive forward-compat) |
| 11 | Wallet schema-version pin bump? | Still drifted (wallet v1, chain v4) | DEFERRED — no new schema fields in window; bump would not clear any concrete issue surfaced this phase |
| 12 | Other CRITICAL/BREAKAGE? | YES — 87 v4.1 protocol-breaking commits | **DEFERRED** to dedicated phase (Edge Case 2 — refactor exceeds sync-phase scope) |

### Wallet-relevant findings

- **No CRITICAL upstream changes** force adaptation now: Sprintnet operators have not been upgraded to the v4.1 binary. The wallet at Phase 11.5 remains compatible with the current chain protocol (18-decimal wei, keccak truncation addresses, hex display, ML-DSA-65 envelope submission).
- **One BREAKAGE risk mitigated defensively**: `3537b135` zero-hash sentinel routes through wallet code that branched on `tokenId !== null && length > 0`, which would misroute zero-hash entries to a phantom token_transfer row. Commit 2 fixes this ahead of operator rollout.
- **Massive v4.1 protocol reframe pending**: when operators do upgrade, the wallet will need a wholesale rewrite (decimals, addresses, denomination, native execution). Tracked for Phase 12+.
- **SDK is packaging-only**: zero source diff. The `0fd8a79` → `ffeb897` window is pure publishability work — no API change, no wallet adaptation, no SDK pin bump needed.

### Wallet actions this phase

- **Commit 1** (`8c2473c`): disable genesis-hash enforcement for Beta (GAP #11 reverted to enable val-1 / GAP #21). Constants + helpers + per-operator cache preserved.
- **Commit 2** (`8b0cf91`): defensive native-LYTH zero-hash sentinel in activity mapper (handles chain `3537b135`).
- **Commit 3** (this entry): chain-sync log entry.

### Categorization summary

- 🔴 CRITICAL deployed: 0 (87 deferred — v4.1 reframe pending operator rollout)
- ⚠️ BREAKAGE deployed: 0 (1 mitigated defensively — `3537b135`)
- 🟡 OPPORTUNISTIC: 1 adopted (defensive fix), 0 deferred
- 🟢 SKIP (pre-v4.1 internal): ~78 commits (warm-restart, dag-sync, AUD evidence, storage box, proposer gates, ferveo tooling)

### Open chain-side gaps still pending (unchanged from 2026-05-16 entry)

- Sprintnet Ferveo binary rollout (single remaining gate for Beta encrypted-submission smoke)
- v4.1 protocol cutover (decimals → 8, addresses → BLAKE3, display → bech32m, denomination → lythoshi, execution → MRV/RISC-V) — Phase 12+ scope
- `lyth_clusterApr` / `lyth_pendingRewards` / `lyth_setAddressLabel` / namingRegistry reader / `lyth_resolveOperatorAuthority` — still unexposed at chain HEAD
- Indexer cluster-wide enable
- Private LYTH Q1 + Q2 (Foundation decision pending)

### Sprintnet operator verification

- 6 canonical operators reachable per `0fd8a79` chain-registry pin (unchanged)
- val-1 (192.0.2.7) **now reachable** with Commit 1 (genesis enforcement disabled)
- Manual smoke required after merge to confirm dispatcher behavior across the 7-operator set

---

## 2026-05-16T14:20Z

**Branch**: `feat/chain-sync-2026-05-16T1420Z`
**Wallet base**: master HEAD `fbebbe7`

**mono-core**: `ce93d83` → `dd05511` (+141 commits)
- 19 V4-API-0001 (terminology sweep — mempool/oracle/VRF/node-registry/execution-tx/consensus-core/staking-rewards renames with back-compat aliases; SDK scan blocker doc-only)
- 10 AUD-0090 (release attestation drills + CI publication of signed artefacts)
- 9 MD-CORE-0004 (reserved-status data dependencies on `lyth_signingActivity`, signing status enums delayed/offline/maintenance)
- 8 AUD-0079 (zkML live readiness gate, vkey in runtime provenance, fulfillment input harness/projection)
- 7 AUD-0087 (rolling upgrade cohort + preflight)
- 7 AUD-0088 (live indexer readiness + public service probe preflight)
- 6 V4-LIVE-0008 (live cohort + mixed-binary/runtime-git divergence)
- 4 MD-CORE-0009 (operator UX: cancel preview risk, swap intent status, pending-set epoch length, operator transaction UX)
- 3 MS-CORE-0008 (stream canonical DAG vertices / gap records / CLOB market trades)
- 3 MS-CORE-0009 (pre-tx hook preview, delegation reward claim ledger)
- 3 AUD-0086 (operator telemetry preflight)
- 53 other (SP1 CUDA zkML prover wired, streaming payment SDK + API v1, operator pending-change risk previews, operator receipt deep links, indexer backfill, DAG sync internals)

**mono-core-sdk**: `0fd8a79` → `0fd8a79` (no new commits since audit baseline)

**Audit themes since baseline**:
- Operator transparency / signing activity: 13 commits (MD-CORE-0004 + supporting)
- zkML readiness & SP1 plumbing: 8+ commits (AUD-0079 + SP1 CUDA wire)
- Live readiness & preflight scripts: 14 commits (AUD-0087 + AUD-0088 + V4-LIVE-0008)
- V4 terminology renames (back-compat preserved): 19 commits
- Release ops + attestation drills: 10 commits
- Streaming canonical surfaces (WS-ready): 3 commits
- Operator UX risk previews: 4 commits
- Pre-tx hook preview + delegation reward claim ledger: 3 commits

**Wallet-relevant flags**:
- **CRITICAL**: none. SDK exports unchanged; V4-API-0001 renames in mono-core preserved back-compat aliases. No wallet break.
- **OPPORTUNISTIC**:
  - `lyth_previewTransactionHooks` (MS-CORE-0009 `13fb4ceb`) — pre-tx hook preview for Send page UX
  - `lyth_signingActivity` + reserved-status (MD-CORE-0004, 9 commits) — Operators page signer-count/status enrichment
  - `lyth_operatorInfo` / `lyth_operatorRisk` / `lyth_cancelPendingChange` / `lyth_submitPendingChange` — operator UX surfaces with receipt deep links + risk previews
  - `lyth_swapIntentStatus` (MD-CORE-0009 `b7380dee`) — forward-looking for Phase 12+ bifurcated denomination crossings
  - `lyth_getServiceProbe` / `lyth_reportServiceProbe` (AUD-0088 + `71606369`) — pairs with wallet's existing `lyth_publicServiceProbe` reference
  - `lyth_upcomingDuties` + committee context + signer counts — Operators page transparency
  - MS-CORE-0008 streaming surfaces (DAG vertices, gap records, CLOB trades) — wallet `ws-client.ts` already supports `lyth_subscribe`
  - Delegation reward claim ledger (MS-CORE-0009 `48c4ba65`) — Staking page enrichment, addresses `lyth_pendingRewards` gap
- **BREAKAGE**: none today. Watch: V4-API-0001 back-compat aliases are documented as transitional — future cleanup commits may remove aliases. Wallet should migrate its 4 named SDK imports forward when the SDK rebases.

**Private LYTH unblock check (Q1 + Q2)**:
- **Q1 (balance display mechanism)**: NOT unblocked. `MS-CORE-0006 wire private activity discriminator` (`95b18dad`) wires a private-activity discriminator into existing activity surface, but no new `lyth_getPrivateBalance` RPC and no `private_balance` field on `lyth_getTokenBalances`. Balance display path still undecided upstream.
- **Q2 (ML-KEM-768 meta-address derivation)**: NOT unblocked. Single transport-mlkem comment reference in diff; no `MetaAddress` type and no derivation surface.

---
