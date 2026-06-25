// Multisig wallets top-level list.
//
// Reached from the MainMenu's "Multisig wallets" item. Displays all
// vaults filtered by kind === "multisig" with their M-of-N pill and
// pending-proposal count. Tapping a row switches the active vault to
// that multisig and routes to its Pending dashboard (existing
// screen). "Create new multisig wallet" CTA reuses the existing
// MultisigCreateModal — no new creation flow.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { MultisigCreateModal } from "../components/MultisigCreateModal";
import { bgVaultsList, bgVaultSelect, type VaultSummary } from "../bg";
import { bech32mDisplay } from "../../shared/bech32m";

interface MultisigListProps {
  onBack: () => void;
  /** Open the multisig vault's Pending proposals dashboard after the
   *  parent App switches the active vault. Called with the vault id
   *  so the parent can also pre-load state if needed. */
  onOpenPending: (vaultId: string) => void;
}

export function MultisigList({ onBack, onOpenPending }: MultisigListProps) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const r = await bgVaultsList();
    if (r.ok) {
      setVaults(r.vaults ?? []);
    } else {
      setVaults([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const multisigs = useMemo(
    () => (vaults ?? []).filter((v) => v.kind === "multisig"),
    [vaults],
  );

  const handleOpen = async (id: string) => {
    const r = await bgVaultSelect(id);
    if (r.ok) {
      onOpenPending(id);
    }
  };

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 15,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Multisig wallets
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        {loading && (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "var(--fg-300)",
              fontSize: 12,
            }}
          >
            Loading…
          </div>
        )}
        {!loading && multisigs.length === 0 && (
          <div
            style={{
              padding: "32px 20px",
              textAlign: "center",
              color: "var(--fg-300)",
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            <div
              style={{
                display: "inline-flex",
                color: "var(--fg-400)",
                marginBottom: 12,
              }}
            >
              <Icon name="multisig" size={36} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-100)" }}>
              No multisig wallets yet
            </div>
            <div style={{ marginTop: 8 }}>
              Multisig wallets require multiple signatures to send
              transactions. Useful for shared accounts, treasuries, or
              extra security.
            </div>
          </div>
        )}
        {!loading && multisigs.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {multisigs.map((v) => (
              <MultisigRow
                key={v.id}
                vault={v}
                onClick={() => void handleOpen(v.id)}
              />
            ))}
          </div>
        )}

        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            style={ctaStyle}
          >
            <Icon name="plus" size={13} />
            Create new multisig wallet
          </button>
        </div>
      </div>

      <MultisigCreateModal
        open={createOpen}
        vaultsCount={vaults?.length ?? 0}
        onClose={() => setCreateOpen(false)}
        onComplete={() => {
          setCreateOpen(false);
          void refresh();
        }}
      />
    </>
  );
}

function MultisigRow({
  vault,
  onClick,
}: {
  vault: VaultSummary;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ext-card"
      style={{
        padding: "12px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: vault.isActive
          ? "var(--gold-bg, rgba(124,127,255,0.18))"
          : "var(--surface-1)",
        border: vault.isActive
          ? "1px solid var(--gold, #7c7fff)"
          : "1px solid var(--fg-700)",
        textAlign: "left",
        cursor: "pointer",
        width: "100%",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "var(--gold-bg, rgba(124,127,255,0.18))",
          color: "var(--gold, #7c7fff)",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        aria-hidden
      >
        <Icon name="multisig" size={16} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--fg-100)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {vault.label}
        </span>
        <span
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-300)",
            letterSpacing: "-0.04em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={bech32mDisplay(vault.addr)}
        >
          {bech32mDisplay(vault.addr)}
        </span>
        <span
          style={{
            display: "inline-flex",
            gap: 6,
            marginTop: 2,
          }}
        >
          <span
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 9,
              padding: "1px 5px",
              borderRadius: 3,
              border: "1px solid rgba(124,127,255,0.4)",
              background: "rgba(124,127,255,0.08)",
              color: "var(--fg-200)",
              letterSpacing: "0.05em",
            }}
          >
            {vault.threshold} of {vault.signerCount}
          </span>
          {vault.pendingCount > 0 && (
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 9,
                padding: "1px 5px",
                borderRadius: 3,
                border: "1px solid rgba(244,201,122,0.4)",
                background: "rgba(244,201,122,0.08)",
                color: "var(--warn, #f4c97a)",
                letterSpacing: "0.05em",
              }}
            >
              {vault.pendingCount} pending
            </span>
          )}
        </span>
      </span>
      <Icon name="chev" size={12} />
    </button>
  );
}

const ctaStyle: CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--gold, #7c7fff)",
  background: "var(--gold-bg, rgba(124,127,255,0.18))",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};
