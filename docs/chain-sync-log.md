# Chain Sync Log

Running log of when browser-wallet baselined against `mono-core` + `mono-core-sdk` upstream. Latest entry first.

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
