// About — wallet identity, version stack, connected-operator readout,
// genesis-hash display, external links, and §28.5 differentiation
// pitch.
//
// Phase 6 commit 4. Pure read-only screen — no writes, no IPC beyond
// the operator-health probe.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import {
  bgOperatorsHealth,
  bgPasskeyGetState,
  bgRuntimeProvenance,
  bgSlhDsaBackupGet,
  bgTwoTierGetState,
  bgVaultsList,
  type BgPasskeyState,
  type OperatorHealthRow,
  type RuntimeProvenanceView,
} from "../bg";
import {
  FEATURE_FLAGS,
  FEATURE_META,
  type TwoTierState,
} from "../../shared/two-tier-features";
import {
  type SlhDsaBackup,
  backupStatusLabel,
  isBackupComplete,
} from "../../shared/slh-dsa-backup";
import {
  EXTERNAL_LINKS,
  SDK_COMMIT_SHORT,
  SDK_PACKAGE_VERSION,
  SDK_REGISTRY_GENESIS_HASH,
  SPRINTNET_CHAIN_ID_DEC,
  SPRINTNET_GENESIS_HASH,
  WALLET_PITCH,
} from "../../shared/build-info";
import { fetchLiveTestnetRegistry } from "../../shared/live-registry";
import {
  OPERATOR_RISK_LEGEND,
  classifyOperatorRisk,
  type OperatorRiskBadge,
} from "../../shared/operator-risk";

interface AboutProps {
  onBack: () => void;
  /** Phase 8 — passed when the active vault is a multisig vault.
   *  Surfaces a §28.5-aligned card explaining the wallet's M-of-N
   *  security model + roster summary + chain-GAP caveat. */
  multisig?: {
    label: string;
    signerCount: number;
    threshold: number;
    pendingCount: number;
    onOpenGovernance: () => void;
  };
  /** Phase 9 — when set, surfaces a §28.5 Q29+Q30+Q31 status card
   *  showing how many passkeys are registered, the policy state, and
   *  which two-tier features are active. */
  phase9?: {
    vaultId: string;
    onOpenSecurity: () => void;
    onOpenFeatures: () => void;
  };
  /** Phase 10 — when set, surfaces a §30.1 backup status card with
   *  the active vault's backup state + a cross-vault "N of M"
   *  aggregate so the user can see at a glance how many of their
   *  vaults have a registered emergency-recovery key. */
  phase10?: {
    activeVaultId: string;
    onOpenSecurity: () => void;
  };
}

function readWalletVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "0.0.1";
  }
}

export function About({ onBack, multisig, phase9, phase10 }: AboutProps) {
  const [operators, setOperators] = useState<OperatorHealthRow[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<RuntimeProvenanceView | null>(
    null,
  );
  const [passkeyState, setPasskeyState] = useState<BgPasskeyState | null>(null);
  const [twoTierState, setTwoTierState] = useState<TwoTierState | null>(null);
  /** Active vault's backup state. */
  const [activeBackup, setActiveBackup] = useState<SlhDsaBackup | null>(null);
  /** Cross-vault aggregate — sums `isBackupComplete` across every
   *  vault in the container. Loaded once on mount. */
  const [aggregate, setAggregate] = useState<{
    total: number;
    complete: number;
    missing: { id: string; label: string }[];
  } | null>(null);
  /** Live GitHub chain-registry snapshot for testnet-69420. Populates
   *  on mount via fetchLiveTestnetRegistry; falls back to the
   *  SDK-bundled value if the GitHub raw URL is unreachable. */
  const [liveRegistryGenesis, setLiveRegistryGenesis] = useState<string | null>(null);
  const [liveRegistryBinarySha, setLiveRegistryBinarySha] = useState<string | null>(null);
  const walletVersion = readWalletVersion();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await fetchLiveTestnetRegistry();
      if (cancelled || info === null) return;
      setLiveRegistryGenesis(info.genesis_hash);
      setLiveRegistryBinarySha(info.binary_sha);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setProbeError(null);
    void (async () => {
      try {
        const r = await bgOperatorsHealth();
        if (cancelled) return;
        if (r.ok) setOperators(r.operators);
      } catch (e) {
        if (cancelled) return;
        setProbeError((e as Error).message ?? "probe failed");
      }
    })();
    void (async () => {
      const r = await bgRuntimeProvenance();
      if (cancelled) return;
      if (r.ok) setProvenance(r.provenance);
    })();
    if (phase9 !== undefined) {
      void (async () => {
        const [pk, tt] = await Promise.all([
          bgPasskeyGetState(phase9.vaultId),
          bgTwoTierGetState(),
        ]);
        if (cancelled) return;
        if (pk.ok) setPasskeyState(pk.state);
        if (tt.ok) setTwoTierState(tt.state);
      })();
    }
    if (phase10 !== undefined) {
      void (async () => {
        // Active vault's backup state + cross-vault aggregate run
        // in parallel — separate IPCs, no inter-dependency. The
        // aggregate makes one `bgVaultsList` call + one
        // `bgSlhDsaBackupGet` per vault. Cheap; the list rarely
        // exceeds a handful of vaults.
        const [activeRes, vaultsRes] = await Promise.all([
          bgSlhDsaBackupGet(phase10.activeVaultId),
          bgVaultsList(),
        ]);
        if (cancelled) return;
        if (activeRes.ok) setActiveBackup(activeRes.backup);
        if (vaultsRes.ok && vaultsRes.vaults !== null) {
          const vaults = vaultsRes.vaults;
          const perVault = await Promise.all(
            vaults.map(async (v) => ({
              id: v.id,
              label: v.label,
              res: await bgSlhDsaBackupGet(v.id),
            })),
          );
          if (cancelled) return;
          let complete = 0;
          const missing: { id: string; label: string }[] = [];
          for (const row of perVault) {
            const backup = row.res.ok ? row.res.backup : null;
            if (isBackupComplete(backup)) complete++;
            else missing.push({ id: row.id, label: row.label });
          }
          setAggregate({ total: vaults.length, complete, missing });
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [phase9, phase10]);

  const healthyCount = operators?.filter((o) => o.ok).length ?? 0;
  const trustedCount = operators?.filter((o) => o.trustedGenesis).length ?? 0;
  const totalCount = operators?.length ?? 0;
  // Phase 7.1 — capability aggregate. Counts operators reporting each
  // surface as "available". Surfaces the "n/m support X" header summary
  // when at least one operator returned capability info; absent when
  // every operator is on a pre-uplift binary.
  const capabilitySummary =
    operators === null
      ? null
      : summariseOperatorCapabilities(operators);
  // The displayed registry genesis hash is the live GitHub value when
  // the fetch succeeded, the SDK-bundled snapshot otherwise. The
  // build-time `SPRINTNET_GENESIS_HASH` pin still gates GAP #11 in
  // networks.ts — this is purely display + drift detection.
  const displayedRegistryGenesis =
    liveRegistryGenesis ?? SDK_REGISTRY_GENESIS_HASH;
  const sdkRegistryMismatch =
    displayedRegistryGenesis.toLowerCase() !==
    SPRINTNET_GENESIS_HASH.toLowerCase();

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          About
        </div>
        <div style={{ width: 28 }} />
      </div>

      <div className="ext-body">
        {/* Identity card */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Monolythium Browser Wallet</h3>
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              marginBottom: 12,
            }}
          >
            Sovereign post-quantum browser wallet for the Monolythium chain.
            Reference implementation of the wallet contract.
          </div>
          <KvList
            rows={[
              { k: "Wallet", v: `v${walletVersion}` },
              { k: "SDK", v: `v${SDK_PACKAGE_VERSION} · ${SDK_COMMIT_SHORT}` },
            ]}
          />
        </div>

        {/* Phase 8 — Multisig vault context card. Renders only when
            the active vault is a multisig vault. Aligns with §28.5
            mandatory multisig surface; flags the chain-GAP off-band
            coordination model explicitly. */}
        {multisig && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Multisig wallet</h3>
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              Active vault &ldquo;{multisig.label}&rdquo; is an N-of-M
              multisig. Every send becomes a proposal that the signer
              committee approves before execution.
            </div>
            <KvList
              rows={[
                {
                  k: "Threshold",
                  v: `${multisig.threshold} of ${multisig.signerCount}`,
                },
                {
                  k: "Pending",
                  v: `${multisig.pendingCount} proposal${multisig.pendingCount === 1 ? "" : "s"}`,
                },
              ]}
            />
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-400)",
                lineHeight: 1.5,
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(242,180,65,0.06)",
                border: "1px solid rgba(242,180,65,0.3)",
              }}
            >
              v1 multisig is off-band coordinated: the wallet enforces
              M-of-N at the UI boundary; the chain verifies the multisig
              vault&apos;s single executor signature only. A future
              user-multisig precompile will close that gap.
            </div>
            <button
              onClick={multisig.onOpenGovernance}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>Signers + governance</span>
              <Icon name="chev" size={12} />
            </button>
          </div>
        )}

        {phase9 && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Passkey + features</h3>
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              Wallet-side passkey policy + two-tier UX. Passkey
              enforcement is wallet-only today; chain precompile is a
              future phase.
            </div>

            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Security
            </div>
            <KvList
              rows={[
                {
                  k: "Passkeys",
                  v: passkeyState
                    ? `${passkeyState.credentials.length} registered`
                    : "—",
                },
                {
                  k: "Policy",
                  v: passkeyState
                    ? passkeyState.policy.enabled
                      ? `${passkeyState.policy.mode} · enabled`
                      : "disabled"
                    : "—",
                },
              ]}
            />
            <button
              onClick={phase9.onOpenSecurity}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>Open Security</span>
              <Icon name="chev" size={12} />
            </button>

            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 6,
                marginTop: 14,
              }}
            >
              Active features
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {twoTierState ? (
                FEATURE_FLAGS.filter((f) => twoTierState[f].enabled).length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--fg-400)" }}>
                    None enabled — wallet shows the minimal surface.
                  </span>
                ) : (
                  FEATURE_FLAGS.filter((f) => twoTierState[f].enabled).map(
                    (f) => (
                      <span
                        key={f}
                        style={{
                          padding: "3px 8px",
                          borderRadius: 6,
                          background: "rgba(244,201,122,0.08)",
                          border: "1px solid rgba(244,201,122,0.4)",
                          color: "var(--gold)",
                          fontFamily: "var(--f-mono)",
                          fontSize: 10.5,
                        }}
                      >
                        {FEATURE_META[f].label}
                      </span>
                    ),
                  )
                )
              ) : (
                <span style={{ fontSize: 11, color: "var(--fg-400)" }}>—</span>
              )}
            </div>
            <button
              onClick={phase9.onOpenFeatures}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>Open Features</span>
              <Icon name="chev" size={12} />
            </button>
          </div>
        )}

        {phase10 && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Emergency recovery</h3>
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--fg-300)",
                lineHeight: 1.5,
                marginBottom: 10,
              }}
            >
              SLH-DSA-SHA2-128s backup keypair, one per vault.
              Hash-based — cross-family hedge against a future
              ML-DSA / lattice break. Wallet-only generation + chain-
              registered public half via the `0x1100` emergency-key
              registry (one-time per address).
            </div>

            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              This vault
            </div>
            <KvList
              rows={[
                {
                  k: "Status",
                  v: activeBackup === null
                    ? "—"
                    : backupStatusLabel(activeBackup),
                },
                ...(activeBackup &&
                activeBackup.chainRegistrationTxHash !== undefined
                  ? [
                      {
                        k: "Tx",
                        v: `${activeBackup.chainRegistrationTxHash.slice(0, 10)}…${activeBackup.chainRegistrationTxHash.slice(-8)}`,
                      },
                    ]
                  : []),
                ...(activeBackup &&
                activeBackup.chainRegistrationBlock !== undefined
                  ? [
                      {
                        k: "Block",
                        v: activeBackup.chainRegistrationBlock.toString(),
                      },
                    ]
                  : []),
              ]}
            />

            {aggregate !== null && aggregate.total > 1 && (
              <>
                <div
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 10,
                    color: "var(--fg-400)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    marginBottom: 6,
                    marginTop: 14,
                  }}
                >
                  All vaults
                </div>
                <div
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "rgba(124,127,255,0.06)",
                    border: "1px solid rgba(124,127,255,0.4)",
                    fontSize: 11.5,
                    color: "var(--fg-100)",
                    lineHeight: 1.5,
                  }}
                >
                  <strong>{aggregate.complete}</strong> of{" "}
                  <strong>{aggregate.total}</strong> vaults have a
                  registered emergency-recovery key.
                  {aggregate.missing.length > 0 && (
                    <div
                      style={{
                        marginTop: 6,
                        fontSize: 10.5,
                        color: "var(--fg-300)",
                      }}
                    >
                      Missing:{" "}
                      {aggregate.missing.map((m) => m.label).join(", ")}
                    </div>
                  )}
                </div>
              </>
            )}

            <button
              onClick={phase10.onOpenSecurity}
              style={{
                marginTop: 10,
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid var(--fg-700)",
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-sans)",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span>Open Security</span>
              <Icon name="chev" size={12} />
            </button>
          </div>
        )}

        {/* Chain card */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Monolythium Testnet</h3>
          </div>
          <KvList
            rows={[
              { k: "Chain ID", v: String(SPRINTNET_CHAIN_ID_DEC) },
              {
                k: "Genesis",
                v: <Mono>{shortHex(SPRINTNET_GENESIS_HASH, 10, 8)}</Mono>,
                title: SPRINTNET_GENESIS_HASH,
              },
              { k: "Execution", v: "Rust/RISC-V native" },
              { k: "Whitepaper", v: "v5.0 · May 2026" },
              { k: "Signing", v: "ML-DSA-65 (FIPS-204)" },
              { k: "Address format", v: "bech32m" },
              { k: "Atomic unit", v: "lythoshi (10⁻⁸ LYTH)" },
              {
                k: "Chain decimal mode",
                v: "legacy compat (wei wire) · wallet compensates",
                title:
                  "V4-LIVE-0008 operators (commit 5aead0f0) still report wei on the wire; wallet converts to lythoshi at IPC boundaries. Flip CHAIN_RETURNS_LEGACY_WEI=false when operators upgrade past a2a9e1fc.",
              },
              {
                k: "EVM compat",
                v: "Bridge active · native removal pending",
                title:
                  "Dapp-facing eth_sendTransaction / personal_sign / eth_signTypedData still bridge through the wallet's ML-DSA-65 backend. Native-only removal is queued for a focused follow-up commit; tracked in dev notes NAYIEM-PING.",
              },
            ]}
          />
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              lineHeight: 1.5,
              background: "rgba(0,0,0,0.2)",
              borderRadius: 8,
              border: "1px solid var(--fg-700)",
              wordBreak: "break-all",
            }}
          >
            {SPRINTNET_GENESIS_HASH}
          </div>
          {sdkRegistryMismatch && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--warn)",
                lineHeight: 1.5,
                background: "rgba(244,201,122,0.08)",
                borderRadius: 8,
                border: "1px solid rgba(244,201,122,0.4)",
              }}
              title={displayedRegistryGenesis}
            >
              {liveRegistryGenesis !== null ? "GitHub" : "SDK bundled"} registry
              reports{" "}
              <span style={{ color: "var(--fg-200)" }}>
                {shortHex(displayedRegistryGenesis, 10, 8)}
              </span>{" "}
              — wallet&apos;s pinned genesis takes precedence until the
              registry resyncs.
              {liveRegistryBinarySha && (
                <>
                  {" "}
                  Live binary sha:{" "}
                  <span style={{ color: "var(--fg-200)" }}>
                    {liveRegistryBinarySha}
                  </span>
                  .
                </>
              )}
            </div>
          )}
        </div>

        {/* Runtime provenance — chain-side build info from lyth_runtimeProvenance.
            Renders when the SW IPC returns data; absent when the chain is
            offline. The wallet still mounts the About page; this card just
            doesn't show. */}
        {provenance !== null && (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Runtime</h3>
              <div className="spacer" />
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  color: "var(--fg-500)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
                title="from lyth_runtimeProvenance"
              >
                chain-reported
              </span>
            </div>
            <KvList
              rows={[
                {
                  k: "Client",
                  v: `${provenance.clientName} v${provenance.version}`,
                },
                {
                  k: "Commit",
                  v: (
                    <Mono>
                      {provenance.gitCommit.slice(0, 12)}
                      {provenance.gitDirty ? "-dirty" : ""}
                    </Mono>
                  ),
                  title: provenance.gitCommit,
                },
                ...(provenance.p2pProtocolVersion !== null
                  ? [
                      {
                        k: "P2P",
                        v: `v${provenance.p2pProtocolVersion}`,
                      },
                    ]
                  : []),
                ...(provenance.latestHeight !== null
                  ? [
                      {
                        k: "Tip",
                        v: <Mono>#{provenance.latestHeight}</Mono>,
                      },
                    ]
                  : []),
              ]}
            />
            {provenance.features.length > 0 && (
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 4,
                }}
              >
                {provenance.features.split(/[,\s]+/).filter(Boolean).map((f) => (
                  <span
                    key={f}
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 9.5,
                      color: "var(--fg-200)",
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid var(--fg-700)",
                      padding: "2px 6px",
                      borderRadius: 4,
                      letterSpacing: "0.04em",
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Operator table */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Operators</h3>
            <div className="spacer" />
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: operators === null ? "var(--fg-500)" : "var(--fg-300)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
              }}
            >
              {operators === null
                ? "probing…"
                : `${trustedCount}/${totalCount} trusted · ${healthyCount} live`}
            </span>
          </div>
          {probeError !== null && (
            <div
              style={{
                fontSize: 11,
                color: "var(--err)",
                marginBottom: 8,
                fontFamily: "var(--f-mono)",
              }}
            >
              {probeError}
            </div>
          )}
          {capabilitySummary !== null && capabilitySummary.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 4,
                marginBottom: 8,
              }}
              title="Operator-reported capability availability (lyth_operatorCapabilities)"
            >
              {capabilitySummary.map((s) => (
                <span
                  key={s.surface}
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 9.5,
                    color:
                      s.available === totalCount
                        ? "var(--ok)"
                        : s.available === 0
                          ? "var(--fg-500)"
                          : "var(--warn)",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid var(--fg-700)",
                    padding: "2px 6px",
                    borderRadius: 4,
                    letterSpacing: "0.04em",
                  }}
                >
                  {s.available}/{totalCount} {s.surface}
                </span>
              ))}
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {operators === null && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--fg-400)",
                  padding: "8px 4px",
                }}
              >
                Probing every active operator…
              </div>
            )}
            {operators !== null &&
              operators.map((op) => <OperatorRow key={op.rpc} row={op} />)}
          </div>
        </div>

        {/* Phase 11 Commit 5 — Operator risk legend. Decodes the chips
            rendered on operator rows above. */}
        <OperatorRiskLegendCard />

        {/* Pitch / differentiation */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Why Monolythium</h3>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {WALLET_PITCH.map((p) => (
              <div key={p.title}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--fg-100)",
                    marginBottom: 3,
                  }}
                >
                  {p.title}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--fg-300)",
                    lineHeight: 1.5,
                  }}
                >
                  {p.body}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Links */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Resources</h3>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            {EXTERNAL_LINKS.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--fg-700)",
                  background: "rgba(255,255,255,0.04)",
                  color: "var(--fg-100)",
                  fontSize: 12.5,
                  textDecoration: "none",
                }}
              >
                <span>{link.label}</span>
                <span
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 10,
                    color: "var(--fg-500)",
                    maxWidth: 180,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {link.url.replace(/^https?:\/\//, "")}
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

interface KvRow {
  k: string;
  v: ReactNode;
  title?: string;
}

function KvList({ rows }: { rows: ReadonlyArray<KvRow> }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {rows.map((row) => (
        <div
          key={row.k}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 11.5,
            gap: 8,
          }}
        >
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {row.k}
          </span>
          <span
            style={{ color: "var(--fg-100)" }}
            title={row.title}
          >
            {row.v}
          </span>
        </div>
      ))}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: "var(--f-mono)", fontSize: 11 }}>{children}</span>
  );
}

function OperatorRow({ row }: { row: OperatorHealthRow }) {
  const ok = row.ok;
  const trusted = row.trustedGenesis;
  // Untrusted (forked) operators are RPC-skipped regardless of liveness,
  // so they get the danger border even when the probe succeeded.
  const dangerBorder = !trusted || !ok;
  // Phase 11 Commit 5 — derive risk badges from probe data.
  const riskBadges = classifyOperatorRisk({
    ok: row.ok,
    trustedGenesis: row.trustedGenesis,
    capabilities: row.capabilities,
    indexerHeight: row.indexerHeight,
    indexerLatest: row.indexerLatest,
    latencyMs: row.ok ? row.latencyMs : null,
    // Phase 11 chain GAP — `lyth_pendingOperatorChanges` (or whatever
    // chain commit 017cab9 ends up calling it) is not in the SDK at
    // @0fd8a79. Once a reader lands, surface `pendingChange` here.
    // The classifier already supports the field; surfaces a "pending"
    // badge with chain-supplied severity when present.
    pendingChange: null,
  });
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "10px 1fr auto",
        gap: 10,
        alignItems: "center",
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(255,255,255,0.03)",
        border: dangerBorder
          ? "1px solid rgba(220,80,80,0.3)"
          : "1px solid var(--fg-700)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dangerBorder ? "var(--err)" : "var(--ok)",
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--fg-100)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>{row.name}</span>
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-500)",
              letterSpacing: "0.04em",
            }}
          >
            {row.region}
          </span>
          {!trusted && (
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 9,
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "var(--err)",
                background: "rgba(220,80,80,0.12)",
                padding: "1px 5px",
                borderRadius: 3,
                border: "1px solid rgba(220,80,80,0.4)",
              }}
              title={
                row.observedGenesis !== null
                  ? `observed genesis: ${row.observedGenesis}`
                  : "operator did not return a genesis block"
              }
            >
              untrusted chain
            </span>
          )}
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={row.rpc}
        >
          {row.rpc.replace(/^https?:\/\//, "")}
        </div>
      </div>
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 10,
          textAlign: "right",
          color: dangerBorder ? "var(--err)" : "var(--ok)",
          minWidth: 56,
        }}
      >
        {ok ? (
          <>
            <div>{row.latencyMs}ms</div>
            {row.blockHex !== null && (
              <div style={{ color: "var(--fg-500)" }}>
                #{parseHex(row.blockHex)}
              </div>
            )}
            {/* Phase 7.1 — indexer lag readout when the operator reports
                an indexer height. Lag = latest - current (one-way; the
                indexer can't be ahead of the chain). */}
            {row.indexerHeight !== null && (
              <div
                style={{ color: "var(--fg-500)" }}
                title="lyth_indexerStatus current/latest height"
              >
                idx #{row.indexerHeight}
                {row.indexerLatest !== null &&
                  row.indexerLatest > row.indexerHeight && (
                    <span style={{ color: "var(--warn)" }}>
                      {" "}
                      ({row.indexerLatest - row.indexerHeight} lag)
                    </span>
                  )}
              </div>
            )}
          </>
        ) : (
          <div>{row.reason}</div>
        )}
      </div>
      {/* Phase 11 Commit 5 — operator risk badges (derived from probe
          data via classifyOperatorRisk). Spans the full row when any
          risk badge applies; absent for healthy operators. */}
      {riskBadges.length > 0 && (
        <div
          style={{
            gridColumn: "1 / -1",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            marginTop: 4,
            paddingTop: 6,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          {riskBadges.map((b) => (
            <RiskBadgeChip key={b.kind} badge={b} />
          ))}
        </div>
      )}
      {/* Phase 7.1 — per-operator capability badge strip. Spans all 3
          columns when present; absent when the operator's response had
          no capabilities or returned an error for `lyth_operatorCapabilities`. */}
      {row.capabilities !== null &&
        Object.keys(row.capabilities).length > 0 && (
          <div
            style={{
              gridColumn: "1 / -1",
              display: "flex",
              flexWrap: "wrap",
              gap: 3,
              marginTop: 4,
              paddingTop: 6,
              borderTop: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            {Object.entries(row.capabilities).map(([surface, status]) => (
              <span
                key={surface}
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 8.5,
                  color:
                    status === "available"
                      ? "var(--ok)"
                      : status === "ws_only"
                        ? "var(--warn)"
                        : "var(--fg-500)",
                  background: "rgba(255,255,255,0.02)",
                  border: "1px solid var(--fg-700)",
                  padding: "1px 4px",
                  borderRadius: 3,
                  letterSpacing: "0.04em",
                }}
                title={`${surface}: ${status}`}
              >
                {surface}
              </span>
            ))}
          </div>
        )}
    </div>
  );
}

/** Phase 11 Commit 5 — render a single risk badge as a coloured chip
 *  with a hover tooltip explaining what tripped it. Severity drives
 *  the colour (info = blue, warn = amber, err = red). */
function RiskBadgeChip({ badge }: { badge: OperatorRiskBadge }) {
  const colour =
    badge.severity === "err"
      ? "var(--err)"
      : badge.severity === "warn"
        ? "var(--warn)"
        : "var(--fg-300)";
  const bg =
    badge.severity === "err"
      ? "rgba(220,80,80,0.12)"
      : badge.severity === "warn"
        ? "rgba(220,180,80,0.12)"
        : "rgba(120,160,220,0.08)";
  const borderColour =
    badge.severity === "err"
      ? "rgba(220,80,80,0.4)"
      : badge.severity === "warn"
        ? "rgba(220,180,80,0.4)"
        : "rgba(120,160,220,0.3)";
  return (
    <span
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: colour,
        background: bg,
        border: `1px solid ${borderColour}`,
        padding: "1px 5px",
        borderRadius: 3,
      }}
      title={badge.tooltip}
    >
      {badge.label}
    </span>
  );
}

/** Phase 11 Commit 5 — Operator-risk legend card rendered on the About
 *  page below the operator probe list. One-line explanation per risk
 *  kind so the user can decode the badges from the probe rows above.
 *  Static (no chain reads); content tracks OPERATOR_RISK_LEGEND. */
function OperatorRiskLegendCard() {
  return (
    <div className="ext-card">
      <div className="ext-card__head">
        <h3>Operator risk legend</h3>
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-400)",
          lineHeight: 1.5,
          marginBottom: 8,
        }}
      >
        Each chip on an operator row decodes a signal the wallet collected
        from its probe round-trip. Most are advisory — the wallet's RPC
        dispatcher already routes around offline / untrusted operators.
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {OPERATOR_RISK_LEGEND.map((entry) => (
          <div key={entry.kind}>
            <div
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: "var(--fg-100)",
                marginBottom: 2,
              }}
            >
              {entry.label}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-300)",
                lineHeight: 1.5,
              }}
            >
              {entry.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CapabilitySummaryEntry {
  surface: string;
  available: number;
}

/** Reduce per-operator capability maps to "n operators report X as
 *  available" entries, sorted so the most-supported surfaces lead. Only
 *  considers surfaces seen on at least one operator — operators on
 *  pre-uplift binaries contribute nothing rather than dragging the
 *  denominator. */
function summariseOperatorCapabilities(
  operators: ReadonlyArray<OperatorHealthRow>,
): CapabilitySummaryEntry[] {
  const counts = new Map<string, number>();
  for (const op of operators) {
    if (op.capabilities === null) continue;
    for (const [surface, status] of Object.entries(op.capabilities)) {
      if (status === "available") {
        counts.set(surface, (counts.get(surface) ?? 0) + 1);
      } else if (!counts.has(surface)) {
        counts.set(surface, 0);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([surface, available]) => ({ surface, available }))
    .sort((a, b) => b.available - a.available || a.surface.localeCompare(b.surface));
}

function parseHex(hex: string): string {
  try {
    return BigInt(hex).toString();
  } catch {
    return "?";
  }
}

function shortHex(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(-tail);
}

const _CSS: CSSProperties | undefined = undefined; // placeholder to satisfy isolatedModules in older tsc
void _CSS;
