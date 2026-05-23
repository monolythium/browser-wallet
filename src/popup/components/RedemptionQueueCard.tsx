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
}

type TicketTone = "ok" | "cooldown" | "pending";

export function RedemptionQueueCard({
  queue,
  isMock,
  error,
  clusters,
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
                    label="Matures"
                    value={`block ${ticket.maturityHeight}`}
                  />
                </div>

                {status.detail !== null && (
                  <div style={statusDetailStyle(status.tone)}>{status.detail}</div>
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
      label: "Mature",
      detail: "Mature at the probed block height.",
      tone: "ok",
    };
  }
  if (ticket.mature === false) {
    return {
      label: "Cooldown",
      detail: `Height-based cooldown until block ${ticket.maturityHeight}.`,
      tone: "cooldown",
    };
  }
  return {
    label: "Pending",
    detail: "Maturity probe unavailable for this block selector.",
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
  return {
    flex: "0 0 auto",
    fontFamily: "var(--f-mono)",
    fontSize: 8.5,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 999,
    color:
      tone === "ok"
        ? "var(--ok)"
        : tone === "cooldown"
          ? "var(--warn)"
          : "var(--fg-300)",
    border:
      tone === "ok"
        ? "1px solid rgba(80,200,120,0.45)"
        : tone === "cooldown"
          ? "1px solid rgba(244,201,122,0.45)"
          : "1px solid var(--fg-700)",
    background:
      tone === "ok"
        ? "rgba(80,200,120,0.08)"
        : tone === "cooldown"
          ? "rgba(244,201,122,0.08)"
          : "rgba(255,255,255,0.03)",
  };
}

function statusDetailStyle(tone: TicketTone): CSSProperties {
  return {
    marginTop: 8,
    fontFamily: "var(--f-mono)",
    fontSize: 9.5,
    color:
      tone === "ok"
        ? "var(--ok)"
        : tone === "cooldown"
          ? "var(--warn)"
          : "var(--fg-500)",
    lineHeight: 1.45,
  };
}
