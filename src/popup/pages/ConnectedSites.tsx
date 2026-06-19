import { useState } from "react";
import { Icon } from "../Icon";
import { Modal } from "../components/Modal";
import { shortBech32m } from "../../shared/bech32m";
import { bgRevokeOrigin, bgRevokeAllOrigins } from "../bg";
import { useConnectedSites } from "../hooks/useConnectedSites";

interface ConnectedSitesProps {
  onBack: () => void;
}

function hostnameOf(origin: string): string {
  try { return new URL(origin).hostname; } catch { return origin; }
}

function relativeTime(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ConnectedSites({ onBack }: ConnectedSitesProps) {
  const { sites, loading } = useConnectedSites();
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = Object.entries(sites).sort(
    (a, b) => b[1].approvedAt - a[1].approvedAt,
  );
  const isEmpty = !loading && rows.length === 0;

  const handleRevoke = async (origin: string) => {
    if (busy) return;
    setBusy(true);
    await bgRevokeOrigin(origin);
    setBusy(false);
  };

  const handleRevokeAll = async () => {
    if (busy) return;
    setBusy(true);
    await bgRevokeAllOrigins();
    setBusy(false);
    setConfirmAllOpen(false);
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div style={{ flex: 1, fontSize: 14, fontWeight: 600, textAlign: "center" }}>
          Connected sites
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        {isEmpty ? (
          <div
            style={{
              marginTop: 80,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              color: "var(--fg-400)",
            }}
          >
            <Icon name="shield" size={22} />
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--fg-300)" }}>
              No sites connected
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--fg-500)",
                textAlign: "center",
                maxWidth: 240,
                lineHeight: 1.5,
              }}
            >
              Sites you approve will appear here. Revoke any time to require a fresh approval on next use.
            </div>
          </div>
        ) : (
          <div className="ext-card">
            <div className="ext-card__head">
              <h3>Approved sites</h3>
              <div className="spacer" />
              <span
                style={{
                  fontFamily: "var(--f-mono)",
                  fontSize: 10,
                  color: "var(--fg-500)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                {rows.length} {rows.length === 1 ? "site" : "sites"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {rows.map(([origin, rec]) => {
                const host = hostnameOf(origin);
                const letter = host.charAt(0).toUpperCase() || "?";
                return (
                  <div
                    key={origin}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "28px 1fr auto",
                      gap: 10,
                      alignItems: "center",
                      padding: "9px 10px",
                      borderRadius: 10,
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid var(--fg-700)",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        fontSize: 12,
                        display: "grid",
                        placeItems: "center",
                        fontFamily: "var(--f-mono)",
                        fontWeight: 700,
                        color: "#fff",
                        background: "linear-gradient(135deg, #8a3fa5, #4a1f5a)",
                      }}
                    >
                      {letter}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5,
                          fontWeight: 500,
                          color: "var(--fg-100)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {host}
                      </div>
                      <div
                        style={{
                          fontFamily: "var(--f-mono)",
                          fontSize: 10,
                          color: "var(--fg-400)",
                          marginTop: 2,
                          letterSpacing: "0.02em",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {relativeTime(rec.approvedAt)} · {shortBech32m(rec.address, 8)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRevoke(origin)}
                      disabled={busy}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 7,
                        border: "1px solid rgba(220,80,80,0.4)",
                        background: "rgba(220,80,80,0.08)",
                        color: "var(--err)",
                        fontFamily: "var(--f-sans)",
                        fontSize: 11,
                        fontWeight: 500,
                        cursor: busy ? "default" : "pointer",
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      Revoke
                    </button>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                marginTop: 14,
                paddingTop: 14,
                borderTop: "1px solid var(--fg-700)",
              }}
            >
              <button
                onClick={() => setConfirmAllOpen(true)}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(220,80,80,0.4)",
                  background: "rgba(220,80,80,0.08)",
                  color: "var(--err)",
                  fontFamily: "var(--f-sans)",
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: busy ? "default" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <Icon name="warn" size={13} />
                Revoke all sites
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={confirmAllOpen}
        onClose={() => { if (!busy) setConfirmAllOpen(false); }}
        title={
          <>
            <Icon name="warn" size={13} />
            <span>Revoke all connections?</span>
          </>
        }
        titleAccent="var(--gold)"
      >
        <div style={{ fontSize: 12, color: "var(--fg-300)", lineHeight: 1.5 }}>
          Every connected site will need to request approval again on next interaction. This does not affect your funds.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => setConfirmAllOpen(false)}
            disabled={busy}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 9,
              border: "1px solid var(--fg-700)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--fg-100)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              fontWeight: 500,
              cursor: busy ? "default" : "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleRevokeAll()}
            disabled={busy}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 9,
              border: "1px solid rgba(220,80,80,0.4)",
              background: "rgba(220,80,80,0.16)",
              color: "var(--err)",
              fontFamily: "var(--f-sans)",
              fontSize: 12,
              fontWeight: 600,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            Revoke all
          </button>
        </div>
      </Modal>
    </>
  );
}
