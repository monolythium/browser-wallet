// About — wallet identity, version stack, connected-operator readout,
// genesis-hash display, external links, and §28.5 differentiation
// pitch.
//
// Phase 6 commit 4. Pure read-only screen — no writes, no IPC beyond
// the operator-health probe.

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../Icon";
import { bgOperatorsHealth, type OperatorHealthRow } from "../bg";
import {
  EXTERNAL_LINKS,
  SDK_COMMIT_SHORT,
  SDK_PACKAGE_VERSION,
  SPRINTNET_CHAIN_ID_DEC,
  SPRINTNET_GENESIS_HASH,
  WALLET_PITCH,
} from "../../shared/build-info";

interface AboutProps {
  onBack: () => void;
}

function readWalletVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "0.0.1";
  }
}

export function About({ onBack }: AboutProps) {
  const [operators, setOperators] = useState<OperatorHealthRow[] | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const walletVersion = readWalletVersion();

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
    return () => {
      cancelled = true;
    };
  }, []);

  const healthyCount = operators?.filter((o) => o.ok).length ?? 0;
  const totalCount = operators?.length ?? 0;

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
            <h3>Monolythium Wallet</h3>
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
            Reference implementation of the §28.5 wallet contract.
          </div>
          <KvList
            rows={[
              { k: "Wallet", v: `v${walletVersion}` },
              { k: "SDK", v: `v${SDK_PACKAGE_VERSION} · ${SDK_COMMIT_SHORT}` },
            ]}
          />
        </div>

        {/* Chain card */}
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Sprintnet</h3>
          </div>
          <KvList
            rows={[
              { k: "Chain ID", v: String(SPRINTNET_CHAIN_ID_DEC) },
              {
                k: "Genesis",
                v: <Mono>{shortHex(SPRINTNET_GENESIS_HASH, 10, 8)}</Mono>,
                title: SPRINTNET_GENESIS_HASH,
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
        </div>

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
                : `${healthyCount}/${totalCount} live`}
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
  const reason = ok ? null : row.reason;
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
        border: ok ? "1px solid var(--fg-700)" : "1px solid rgba(220,80,80,0.3)",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: ok ? "var(--ok)" : "var(--err)",
          flexShrink: 0,
        }}
      />
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--fg-100)",
          }}
        >
          {row.name}
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-500)",
              marginLeft: 6,
              letterSpacing: "0.04em",
            }}
          >
            {row.region}
          </span>
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
          color: ok ? "var(--ok)" : "var(--err)",
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
          </>
        ) : (
          <div>{reason}</div>
        )}
      </div>
    </div>
  );
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
