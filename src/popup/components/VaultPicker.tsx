// Phase 5 Commit 3 — multi-vault selector. Replaces the legacy active-
// account chip in the popup header.
//
// Whitepaper §21.2.1: "Power users wanting multiple accounts ... use the
// keystore format with a wallet that manages many keystores." The
// container surface from Commit 2 (bgVaultsList / bgVaultSelect /
// bgVaultRename) is what this picker consumes.
//
// Anchored dropdown opens below the chip. Click outside or press Escape
// to dismiss. Per-row rename via the Modal primitive — Modal handles
// its own Escape, and the dropdown's Escape listener is gated off
// while the rename modal is open so the two don't double-fire.
//
// Pre-migration state — `bgVaultsList` returns `vaults: null` while the
// wallet is still on the legacy single-vault entry. The chip renders
// disabled (no dropdown opens) with a "Vaults appear after first
// unlock" tooltip. Same disabled treatment during the brief pre-fetch
// loading tick before the first bgVaultsList resolves.
//
// Add CTAs in the dropdown footer are no-ops in this commit — the
// VaultAddModal lands in Commit 4. Both close the dropdown so a future
// modal can open without overlap.
//
// TODO: VaultPicker test coverage — popup-side React test infra
// (@testing-library/react + jsdom) doesn't exist in this codebase yet.
// Coverage planned in a Phase 8 hardening pass alongside other popup
// component tests.

import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";

import { Icon, shortAddr } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import { Modal } from "./Modal";
import { RevealableAddressBlock } from "./RevealableAddressBlock";
import {
  bgVaultsList,
  bgVaultSelect,
  bgVaultRename,
  type VaultSummary,
} from "../bg";
import type { Account } from "../demo-data";

const MAX_LABEL_LEN = 32;

export interface VaultPickerProps {
  /** Active account passed through from the parent header — used to
   *  render the chip's visible label + address regardless of container
   *  state (so the pre-migration disabled chip still shows the user's
   *  current address line). */
  activeAccount: Account;
}

export function VaultPicker({ activeAccount }: VaultPickerProps) {
  // undefined = pre-fetch tick; null = bgVaultsList resolved with no
  // container (still legacy single-vault); array = container ready.
  const [vaults, setVaults] = useState<VaultSummary[] | null | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    const r = await bgVaultsList();
    setVaults(r.ok ? r.vaults : null);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Click-outside dismissal — bind only while the dropdown is open.
  // The Modal primitive renders via createPortal into document.body,
  // so clicks inside the rename modal are OUTSIDE wrapRef and would
  // normally close the dropdown. We accept that — the rename flow
  // already closes the dropdown implicitly when finished.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && wrapRef.current && !wrapRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Escape closes the dropdown — but only when the rename modal is
  // NOT open. Modal's own document keydown listener handles its
  // Escape; gating here keeps the two from racing.
  useEffect(() => {
    if (!open || renameId !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, renameId]);

  const ready = Array.isArray(vaults) && vaults.length > 0;

  const handleChipClick = () => {
    if (!ready) return;
    setOpen((v) => !v);
  };

  const handleRowClick = async (id: string) => {
    if (!vaults) return;
    const target = vaults.find((v) => v.id === id);
    if (!target || target.isActive) {
      setOpen(false);
      return;
    }
    const r = await bgVaultSelect(id);
    if (r.ok) {
      await refresh();
    }
    setOpen(false);
  };

  const handleStartRename = (id: string) => {
    setRenameId(id);
  };

  const handleCommitRename = async (newLabel: string) => {
    if (renameId === null) return;
    const trimmed = newLabel.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LEN) return;
    const r = await bgVaultRename(renameId, trimmed);
    if (r.ok) {
      await refresh();
    }
    setRenameId(null);
  };

  const handleCancelRename = () => setRenameId(null);

  const handleAddFresh = () => {
    setOpen(false);
    // TODO Commit 4: open VaultAddModal in fresh mode
  };
  const handleAddImport = () => {
    setOpen(false);
    // TODO Commit 4: open VaultAddModal in import mode
  };

  const chipDisabledStyle: CSSProperties = ready
    ? { cursor: "pointer" }
    : { cursor: "not-allowed", opacity: 0.7 };

  const renameTarget =
    renameId !== null && vaults
      ? vaults.find((v) => v.id === renameId) ?? null
      : null;

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      <div
        className="ext-acc"
        onClick={handleChipClick}
        aria-disabled={!ready}
        title={ready ? undefined : "Vaults appear after first unlock"}
        style={chipDisabledStyle}
      >
        <div className="ext-acc__lbl">
          <div
            className="n"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={activeAccount.label}
            >
              {activeAccount.label}
            </span>
            <span
              style={{
                color: "var(--fg-300)",
                flexShrink: 0,
                display: "inline-flex",
                transform: open ? "rotate(180deg)" : "none",
                transition: "transform 120ms ease",
              }}
            >
              <Icon name="chev-d" size={12} />
            </span>
          </div>
          <div
            className="a"
            style={{ display: "flex", flexDirection: "column", gap: 2 }}
          >
            <RevealableAddressBlock addr0x={activeAccount.addr} />
          </div>
        </div>
      </div>

      {open && ready && (
        <div
          role="listbox"
          aria-label="Vaults"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 100,
            background: "var(--ink-100, #15161a)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 12,
            boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
            padding: 4,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {(vaults ?? []).map((v) => (
            <VaultRow
              key={v.id}
              vault={v}
              onSelect={() => void handleRowClick(v.id)}
              onRename={() => handleStartRename(v.id)}
            />
          ))}
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              margin: "4px 0",
            }}
          />
          <FooterButton onClick={handleAddFresh} label="New vault" />
          <FooterButton onClick={handleAddImport} label="Import existing" />
        </div>
      )}

      <Modal
        open={renameId !== null}
        onClose={handleCancelRename}
        title="Rename vault"
      >
        {renameTarget && (
          <RenameForm
            initialLabel={renameTarget.label}
            onCommit={(label) => void handleCommitRename(label)}
            onCancel={handleCancelRename}
          />
        )}
      </Modal>
    </div>
  );
}

interface VaultRowProps {
  vault: VaultSummary;
  onSelect: () => void;
  onRename: () => void;
}

function VaultRow({ vault, onSelect, onRename }: VaultRowProps) {
  const displayAddr = shortAddr(bech32mDisplay(vault.addr), 12);
  return (
    <div
      role="option"
      aria-selected={vault.isActive}
      onClick={onSelect}
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto auto",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        cursor: vault.isActive ? "default" : "pointer",
        background: vault.isActive ? "rgba(255,255,255,0.04)" : "transparent",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--fg-100)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={vault.label}
        >
          {vault.label}
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {displayAddr}
        </div>
      </div>
      <span
        aria-hidden={!vault.isActive}
        style={{
          visibility: vault.isActive ? "visible" : "hidden",
          display: "inline-flex",
          color: "var(--ok, #5fc97a)",
        }}
      >
        <Icon name="check" size={14} />
      </span>
      <button
        type="button"
        aria-label={`Rename ${vault.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onRename();
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          padding: 0,
          background: "transparent",
          border: "none",
          color: "var(--fg-400)",
          cursor: "pointer",
        }}
      >
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}

interface FooterButtonProps {
  onClick: () => void;
  label: string;
}

function FooterButton({ onClick, label }: FooterButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 8,
        background: "transparent",
        border: "none",
        color: "var(--fg-100)",
        fontSize: 12,
        fontFamily: "var(--f-sans)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <Icon name="plus" size={12} />
      {label}
    </button>
  );
}

interface RenameFormProps {
  initialLabel: string;
  onCommit: (newLabel: string) => void;
  onCancel: () => void;
}

function RenameForm({ initialLabel, onCommit, onCancel }: RenameFormProps) {
  const [value, setValue] = useState(initialLabel);
  const trimmed = value.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= MAX_LABEL_LEN;
  const isUnchanged = trimmed === initialLabel.trim();
  const canSubmit = isValid && !isUnchanged;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onCommit(trimmed);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        type="text"
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        maxLength={MAX_LABEL_LEN}
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--fg-700)",
          background: "rgba(0,0,0,0.3)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-sans)",
          fontSize: 12,
          outline: "none",
        }}
      />
      <div
        style={{
          fontSize: 10,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
        }}
      >
        {trimmed.length}/{MAX_LABEL_LEN}
      </div>
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "flex-end",
          marginTop: 2,
        }}
      >
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid var(--fg-700)",
            background: "transparent",
            color: "var(--fg-100)",
            fontFamily: "var(--f-sans)",
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            border: "1px solid rgba(124,127,255,0.6)",
            background: canSubmit
              ? "rgba(124,127,255,0.18)"
              : "rgba(124,127,255,0.06)",
            color: canSubmit ? "var(--fg-100)" : "var(--fg-500)",
            fontFamily: "var(--f-sans)",
            fontSize: 11.5,
            fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}
