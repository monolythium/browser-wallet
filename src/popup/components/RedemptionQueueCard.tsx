import { useMemo, type CSSProperties } from "react";
import type {
  ClusterDirectoryEntry,
  RedemptionQueueRow,
  RedemptionQueueView,
} from "../../shared/staking";
import { lythoshiToLythDecimal } from "../../shared/native-amount";

interface RedemptionQueueCardProps {
  queue: RedemptionQueueView | null;
  isMock: boolean;
  error: string | null;
  clusters: ReadonlyArray<ClusterDirectoryEntry>;
  /** Submit `completeRedemption(index)` for a matured ticket. When
   *  omitted (e.g. the queue is the local fallback) the per-ticket
   *  action is hidden. */
  onComplete?: ((ticketIndex: number) => void) | undefined;
  /** Ticket index whose completion tx is in flight; disables that
   *  ticket's button while submitting. */
  completingIndex?: number | null;
}

type TicketTone = "ready" | "cooldown" | "pending";

export function RedemptionQueueCard({
  queue,
  isMock,
  error,
  clusters,
  onComplete,
  completingIndex = null,
}: RedemptionQueueCardProps) {
  const clusterById = useMemo(() => {
    const m = new Map<number, ClusterDirectoryEntry>();
    for (const c of clusters) m.set(c.clusterId, c);
    return m;
  }, [clusters]);

  const ticketCount = queue?.rows.length ?? 0;

  return (
    <div className="ext-card" style={{ padding: 12 }}>
      <div style={headerStyle}>
        <div style={cardLabel}>Redemption queue</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {queue !== null && (
            <span style={countBadgeStyle}>
              {ticketCount} ticket{ticketCount === 1 ? "" : "s"}
            </span>
          )}
          {isMock && (
            <span
              style={mockBadgeStyle}
              title="Live redemption queue read is unavailable from this operator."
            >
              fallback
            </span>
          )}
        </div>
      </div>

      {error !== null ? (
        <div style={errorBannerStyle}>{error}</div>
      ) : queue === null ? (
        <div style={mutedLineStyle}>Loading redemption queue...</div>
      ) : queue.rows.length === 0 ? (
        <div style={mutedLineStyle}>
          {isMock
            ? "Live redemption queue is unavailable; no local mock tickets are shown."
            : "No redemption tickets are queued for this wallet."}
        </div>
      ) : (
        <div style={ticketListStyle}>
          {queue.rows.map((ticket) => {
            const cluster = clusterById.get(ticket.cluster);
            const status = redemptionTicketStatus(ticket);
            const amount = formatRedemptionQueueAmount(ticket.amountLythoshi);
            return (
              <div key={ticket.index} style={ticketRowStyle}>
                <div style={ticketTopStyle}>
                  <div style={{ minWidth: 0 }}>
                    <div style={ticketTitleStyle}>
                      {cluster?.name ?? `cluster-${ticket.cluster}`}
                    </div>
                    <div style={ticketMetaStyle}>ticket #{ticket.index}</div>
                  </div>
                  <span style={statusBadgeStyle(status.tone)}>{status.label}</span>
                </div>

                <div style={detailGridStyle}>
                  <TicketKv
                    label="Weight"
                    value={`${(ticket.weightBps / 100).toFixed(2)}%`}
                  />
                  {amount !== null && <TicketKv label="Amount" value={amount} />}
                  <TicketKv
                    label="Created"
                    value={`block ${ticket.createdHeight}`}
                  />
                  <TicketKv
                    label="Maturity height"
                    value={`block ${ticket.maturityHeight}`}
                  />
                </div>

                {status.detail !== null && (
                  <div style={statusDetailStyle(status.tone)}>{status.detail}</div>
                )}

                {onComplete !== undefined && ticket.mature === true && (
                  <button
                    type="button"
                    onClick={() => onComplete(ticket.index)}
                    disabled={completingIndex === ticket.index}
                    style={completeBtnStyle(completingIndex === ticket.index)}
                  >
                    {completingIndex === ticket.index
                      ? "Completing…"
                      : "Complete redemption"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function redemptionTicketStatus(ticket: RedemptionQueueRow): {
  label: string;
  detail: string | null;
  tone: TicketTone;
} {
  if (ticket.mature === true) {
    return {
      label: "Ready to redeem",
      detail:
        "This ticket has matured. Complete the redemption to return the principal to your balance.",
      tone: "ready",
    };
  }
  if (ticket.mature === false) {
    return {
      label: "Maturing",
      detail: `Matures at block ${ticket.maturityHeight}; the principal becomes redeemable then.`,
      tone: "cooldown",
    };
  }
  return {
    label: "Probe pending",
    detail:
      "Maturity could not be determined for this block selector. Once the ticket matures you can complete the redemption to return the principal.",
    tone: "pending",
  };
}

export function formatRedemptionQueueAmount(
  amountLythoshi: string | null,
): string | null {
  if (amountLythoshi === null) return null;
  if (!/^\d+$/.test(amountLythoshi)) return null;
  return `${lythoshiToLythDecimal(BigInt(amountLythoshi), 8)} LYTH`;
}

function TicketKv({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={kvLabelStyle}>{label}</div>
      <div style={kvValueStyle}>{value}</div>
    </div>
  );
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const cardLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};

const countBadgeStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 8.5,
  color: "var(--fg-400)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const mockBadgeStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 8.5,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  padding: "1px 5px",
  borderRadius: 3,
  background: "rgba(244,201,122,0.08)",
  border: "1px solid rgba(244,201,122,0.4)",
  color: "var(--warn)",
};

const mutedLineStyle: CSSProperties = {
  marginTop: 8,
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  color: "var(--fg-400)",
  lineHeight: 1.5,
};

const errorBannerStyle: CSSProperties = {
  marginTop: 8,
  padding: "8px 10px",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  border: "1px solid rgba(220,80,80,0.4)",
  color: "var(--err)",
  fontFamily: "var(--f-mono)",
  fontSize: 10.5,
  lineHeight: 1.5,
  wordBreak: "break-word",
};

const ticketListStyle: CSSProperties = {
  marginTop: 10,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxHeight: 230,
  overflowY: "auto",
};

const ticketRowStyle: CSSProperties = {
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.02)",
};

const ticketTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 8,
};

const ticketTitleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--fg-100)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ticketMetaStyle: CSSProperties = {
  marginTop: 2,
  fontFamily: "var(--f-mono)",
  fontSize: 9.5,
  color: "var(--fg-500)",
};

const detailGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px 10px",
  marginTop: 8,
};

const kvLabelStyle: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 8.5,
  color: "var(--fg-500)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const kvValueStyle: CSSProperties = {
  marginTop: 2,
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-200)",
  overflowWrap: "anywhere",
};

function statusBadgeStyle(tone: TicketTone): CSSProperties {
  if (tone === "ready") {
    return {
      flex: "0 0 auto",
      fontFamily: "var(--f-mono)",
      fontSize: 8.5,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      padding: "2px 6px",
      borderRadius: 999,
      color: "var(--ok)",
      border: "1px solid rgba(80,200,120,0.45)",
      background: "rgba(80,200,120,0.08)",
    };
  }
  const attentionTone = tone === "cooldown";
  return {
    flex: "0 0 auto",
    fontFamily: "var(--f-mono)",
    fontSize: 8.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 999,
    color: attentionTone ? "var(--warn)" : "var(--fg-300)",
    border: attentionTone
      ? "1px solid rgba(244,201,122,0.45)"
      : "1px solid var(--fg-700)",
    background: attentionTone
      ? "rgba(244,201,122,0.08)"
      : "rgba(255,255,255,0.03)",
  };
}

function statusDetailStyle(tone: TicketTone): CSSProperties {
  const color =
    tone === "ready"
      ? "var(--ok)"
      : tone === "cooldown"
        ? "var(--warn)"
        : "var(--fg-500)";
  return {
    marginTop: 8,
    fontFamily: "var(--f-mono)",
    fontSize: 9.5,
    color,
    lineHeight: 1.45,
  };
}

function completeBtnStyle(disabled: boolean): CSSProperties {
  return {
    marginTop: 8,
    width: "100%",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(80,200,120,0.45)",
    background: "rgba(80,200,120,0.08)",
    color: "var(--ok)",
    fontFamily: "var(--f-mono)",
    fontSize: 10,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}
