// Multi-vault selector. Replaces the legacy active-
// account chip in the popup header.
//
// Whitepaper §21.2.1: "Power users wanting multiple accounts ... use the
// keystore format with a wallet that manages many keystores." The
// container surface (bgVaultsList / bgVaultSelect /
// bgVaultRename) is what this picker consumes.
//
// Anchored dropdown opens below the chip. Click outside or press Escape
// to dismiss. Per-row rename via the Modal primitive — Modal handles
// its own Escape, and the dropdown's Escape listener is gated off
// while the rename modal is open so the two don't double-fire. The
// same gating applies while the VaultAddModal is open.
//
// Dropdown is rendered via createPortal into document.body
// and anchored via the chip's getBoundingClientRect. The previous
// position:absolute / zIndex:100 implementation rendered behind the
// AVAILABLE LYTH balance card because the popup's `.ext-card` containers
// create their own stacking contexts (position: relative + backdrop-
// filter). Bumping zIndex inside that context did nothing; portaling
// to <body> escapes the constraint cleanly. Position recomputes on
// window resize. Click-outside detection now checks both the chip
// wrapper AND the portal'd panel since they're DOM-disconnected.
//
// Pre-migration state — `bgVaultsList` returns `vaults: null` while the
// wallet is still on the legacy single-vault entry. The chip renders
// disabled (no dropdown opens) with a "Vaults appear after first
// unlock" tooltip. Same disabled treatment during the brief pre-fetch
// loading tick before the first bgVaultsList resolves.
//
// Dropdown footer CTAs open a two-mode VaultAddModal
// (fresh / import) via `addMode` state. Each CTA closes the dropdown
// before flipping `addMode`, so the modal lands cleanly atop the
// header instead of overlapping the dropdown panel.
//
// TODO: VaultPicker test coverage — popup-side React test infra
// (@testing-library/react + jsdom) doesn't exist in this codebase yet.
// Coverage planned in a future hardening pass alongside other popup
// component tests.

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import { Icon, shortAddr } from "../Icon";
import { bech32mDisplay } from "../../shared/bech32m";
import { Modal } from "./Modal";
import { CheckIcon, ClipboardIcon } from "./AddressLine";
import { VaultAddModal, type VaultAddMode } from "./VaultAddModal";
import { MultisigCreateModal } from "./MultisigCreateModal";
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
   *  render the chip's address regardless of container state. The chip's
   *  visible LABEL no longer falls back to `activeAccount.label`; the
   *  active vault's `label` from `bgVaultsList()` is the single source of
   *  truth, with a neutral em-dash placeholder during the pre-fetch tick. */
  activeAccount: Account;
  /** Active vault label, seeded from the parent (App's already-fetched
   *  loadActiveVaultSummary). Used ONLY as the chip's first-paint fallback so
   *  it shows the real name instead of "—" before this component's own
   *  bgVaultsList resolves; the self-fetched `activeVault` (authoritative,
   *  carries `isActive`) supersedes it once in. Sourced from the vault summary
   *  label only — never `activeAccount.label`. */
  activeVaultLabel?: string;
  /** When provided, the dropdown's "New wallet"
   *  CTA dispatches to this callback (typically App-level
   *  navigateTo("new-wallet-flow")) instead of opening the legacy
   *  single-page VaultAddModal fresh mode. Import + multisig
   *  modes still go through VaultAddModal so the in-app flow
   *  changes only affect the fresh-mnemonic path. */
  onNewWalletFlow?: () => void;
  /** Fires after a VaultAddModal (or MultisigCreateModal) completion so
   *  the parent can re-run its hydration (`refreshKeystoreStatus` →
   *  `loadActiveAccount` + `loadActiveVaultSummary`). Without this the
   *  picker would only refresh its own list and the App-level state
   *  would still reflect the pre-import vault, leaving the chip showing
   *  a stale label until lock/unlock or reopen remounted the tree. */
  onVaultComplete?: () => void;
}

/**
 * Resolve the chip's visible label with a deliberate precedence:
 *   1. `selfFetchedActiveLabel` — this component's own bgVaultsList result for
 *      the `isActive` vault. Authoritative; supersedes the seed once in.
 *   2. `seededLabel` — the parent-passed `activeVaultLabel` (App's already-
 *      fetched loadActiveVaultSummary). First-paint fallback so the chip shows
 *      the real name instead of "—" before this component's fetch resolves.
 *   3. `"—"` — neutral em-dash floor while neither has resolved.
 * Both inputs are vault-summary labels — NEVER activeAccount.label (which once
 * leaked the algo name "ML-DSA-65 wallet" on first install). Exported pure so
 * the precedence (incl. the supersede edge SSR render can't reach) is testable.
 */
export function resolveVaultChipLabel(
  selfFetchedActiveLabel: string | null | undefined,
  seededLabel: string | undefined,
): string {
  return selfFetchedActiveLabel ?? seededLabel ?? "—";
}

export function VaultPicker({
  activeAccount,
  activeVaultLabel,
  onNewWalletFlow,
  onVaultComplete,
}: VaultPickerProps) {
  // undefined = pre-fetch tick; null = bgVaultsList resolved with no
  // container (still legacy single-vault); array = container ready.
  const [vaults, setVaults] = useState<VaultSummary[] | null | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<VaultAddMode | null>(null);
  const [multisigOpen, setMultisigOpen] = useState(false);
  // wrapRef wraps the chip + portal mount point and backs the
  // click-outside check on the chip side. portalRef is attached to
  // the portal'd dropdown panel so the same listener can also tell
  // "click landed on a row" from "click landed elsewhere on body".
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chipRef = useRef<HTMLDivElement | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);
  // Anchor position for the portal'd dropdown — recomputed on open
  // + on window resize. `null` while closed; setting it to
  // coordinates triggers the portal render.
  const [anchor, setAnchor] = useState<
    | { top: number; left: number; width: number }
    | null
  >(null);

  const recomputeAnchor = useCallback(() => {
    const el = chipRef.current;
    if (!el) {
      setAnchor(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setAnchor({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const refresh = async () => {
    const r = await bgVaultsList();
    setVaults(r.ok ? r.vaults : null);
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Recompute anchor on open + on window resize while open. The
  // popup body itself doesn't scroll under the header in normal use
  // (the header chip sits in the fixed top region), so a scroll
  // listener isn't strictly needed for the 380 px popup viewport.
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    recomputeAnchor();
    const onResize = () => recomputeAnchor();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, recomputeAnchor]);

  // Click-outside dismissal — bind only while the dropdown is open.
  // The dropdown is portal'd into document.body, so
  // the chip wrapper alone is no longer enough to recognise an
  // in-bounds click — we have to also consult the portal subtree.
  // The Modal primitive renders via createPortal too, but the
  // rename / add modals already close the dropdown implicitly when
  // they open, so we don't need to special-case them here.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (wrapRef.current && wrapRef.current.contains(target)) return;
      if (portalRef.current && portalRef.current.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  // Escape closes the dropdown — but only when no Modal is open.
  // Modal's own document keydown listener handles its Escape; gating
  // here keeps the two from racing for both rename and add flows.
  useEffect(() => {
    if (!open || renameId !== null || addMode !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, renameId, addMode]);

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
    // When the parent wired the new multi-step
    // flow, dispatch there instead of opening the legacy modal.
    // Falls back to the modal when no callback is provided (e.g.
    // test harnesses without the routing wired).
    if (onNewWalletFlow) {
      onNewWalletFlow();
      return;
    }
    setAddMode("fresh");
  };
  const handleAddImport = () => {
    setOpen(false);
    setAddMode("import");
  };
  const handleAddMultisig = () => {
    setOpen(false);
    setMultisigOpen(true);
  };
  const handleAddCancel = () => setAddMode(null);
  const handleAddComplete = async () => {
    setAddMode(null);
    await refresh();
    onVaultComplete?.();
  };
  const handleMultisigCancel = () => setMultisigOpen(false);
  const handleMultisigComplete = async () => {
    setMultisigOpen(false);
    await refresh();
    onVaultComplete?.();
  };

  const chipDisabledStyle: CSSProperties = ready
    ? { cursor: "pointer" }
    : { cursor: "not-allowed", opacity: 0.7 };

  const renameTarget =
    renameId !== null && vaults
      ? vaults.find((v) => v.id === renameId) ?? null
      : null;

  // Top-bar redesign. The previous layout truncated the
  // bech32m address to 12+12 chars with shortAddr; users reported
  // they wanted the full 43-char bech32m visible on a single line.
  // 12 px JetBrains Mono fits 43 chars in ~310 px (well within the
  // 380 px popup minus chip padding + copy button). Wallet label
  // moves UP to row 1 (renamable from there); full address sits in
  // row 2 with a dedicated copy button. The ML-DSA-65 algo label
  // moved OUT of the chip entirely (lives in .ext-top above) so the
  // chip's row 2 is purely the address line.
  const activeVault = ready ? vaults!.find((v) => v.isActive) ?? null : null;
  const displayLabel = resolveVaultChipLabel(activeVault?.label, activeVaultLabel);
  const fullAddr = bech32mDisplay(activeAccount.addr);
  const [addrCopied, setAddrCopied] = useState(false);
  const handleAddrCopy = (e: ReactMouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(fullAddr).then(
      () => {
        setAddrCopied(true);
        setTimeout(() => setAddrCopied(false), 1500);
      },
      () => {},
    );
  };
  const handleTopBarRename = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (!activeVault) return;
    setOpen(false);
    setRenameId(activeVault.id);
  };

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        // Anchor the dropdown to the whole top-bar (selector + address) so it
        // opens below the address block, not over it.
        chipRef.current = el;
      }}
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Wallet selector — the "Wallet 1" pill. Clicking it (or the chevron)
          opens the picker; rename pencil is inside. The address moved to its
          own block below: a visual separation, no logic change. */}
      <div
        className="ext-acc"
        onClick={handleChipClick}
        role="button"
        tabIndex={ready ? 0 : -1}
        aria-disabled={!ready}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={ready ? "Switch wallet" : "Wallets appear after first unlock"}
        onKeyDown={(e) => {
          if (!ready) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleChipClick();
          }
        }}
        style={chipDisabledStyle}
      >
        <div className="ext-acc__lbl">
          {/* 3-column grid so the name + pencil cluster sits visually centered
             regardless of the right-side cluster (multisig pill + chevron). */}
          <div
            className="n"
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto 1fr",
              alignItems: "center",
              gap: 6,
            }}
          >
            {/* Col 1 — ML-DSA-65 algo label, moved up here from the .ext-top
               row above so the name sits in the top row and the left isn't
               wasted empty space. */}
            <span
              style={{
                justifySelf: "start",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "var(--f-mono)",
                fontSize: 8.5,
                fontWeight: 600,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--fg-400)",
              }}
            >
              ML-DSA-65
            </span>
            {/* Col 2 — name + pencil cluster (centered). */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minWidth: 0,
              }}
            >
              <span
                title={displayLabel}
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--f-sans)",
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--fg-100)",
                  letterSpacing: "-0.01em",
                }}
              >
                {displayLabel}
              </span>
              {activeVault && (
                <button
                  type="button"
                  onClick={handleTopBarRename}
                  aria-label="Rename wallet"
                  title="Rename wallet"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    padding: 0,
                    background: "transparent",
                    border: "none",
                    color: "var(--fg-400)",
                    cursor: "pointer",
                    flexShrink: 0,
                  }}
                >
                  <Icon name="pen" size={11} />
                </button>
              )}
            </span>
            {/* Col 3 — right-aligned cluster (multisig pill + chevron). */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                justifySelf: "end",
              }}
            >
              {activeVault?.kind === "multisig" && (
                <span
                  style={{
                    fontFamily: "var(--f-mono)",
                    fontSize: 9,
                    padding: "1px 4px",
                    borderRadius: 3,
                    border: "1px solid rgba(var(--gold-glow), 0.4)",
                    background: "rgba(var(--gold-glow), 0.08)",
                    color: "var(--fg-200)",
                    letterSpacing: "0.05em",
                    flexShrink: 0,
                  }}
                  title={`${activeVault.threshold} of ${activeVault.signerCount} multisig`}
                >
                  {activeVault.threshold}/{activeVault.signerCount}
                </span>
              )}
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
            </span>
          </div>
        </div>
      </div>

      {/* Address — a SEPARATE block below the selector pill (the visual
          separation the design asks for): full bech32m address (wraps, never
          truncates) + copy button. Tapping copies; it is NOT part of the
          picker hit-area, so it never opens the dropdown. */}
      <div className="ext-acc-addr">
        <span
          onClick={handleAddrCopy}
          title={addrCopied ? "Copied" : fullAddr}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontFamily: "var(--f-mono)",
            fontSize: 13,
            fontWeight: 500,
            color: addrCopied ? "var(--ok, #5fc97a)" : "var(--fg-100)",
            letterSpacing: "-0.02em",
            cursor: "copy",
          }}
        >
          {fullAddr}
        </span>
        <button
          type="button"
          onClick={handleAddrCopy}
          aria-label="Copy address"
          title={addrCopied ? "Copied" : "Copy address"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            padding: 0,
            background: "transparent",
            border: "none",
            color: addrCopied ? "var(--ok, #5fc97a)" : "var(--fg-400)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {addrCopied ? <CheckIcon /> : <ClipboardIcon />}
        </button>
      </div>

      {open && ready && anchor &&
        createPortal(
          <div
            ref={portalRef}
            role="listbox"
            aria-label="Vaults"
            style={{
              position: "fixed",
              top: anchor.top,
              left: anchor.left,
              width: anchor.width,
              zIndex: 9999,
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
            <FooterButton onClick={handleAddFresh} label="New wallet" />
            <FooterButton onClick={handleAddImport} label="Import existing" />
            <FooterButton
              onClick={handleAddMultisig}
              label="New multisig wallet"
            />
          </div>,
          document.body,
        )}

      <Modal
        open={renameId !== null}
        onClose={handleCancelRename}
        title="Rename wallet"
      >
        {renameTarget && (
          <RenameForm
            initialLabel={renameTarget.label}
            onCommit={(label) => void handleCommitRename(label)}
            onCancel={handleCancelRename}
          />
        )}
      </Modal>

      {addMode !== null && (
        <VaultAddModal
          open={true}
          initialMode={addMode}
          vaultsCount={vaults?.length ?? 0}
          onClose={handleAddCancel}
          onComplete={() => void handleAddComplete()}
        />
      )}

      {multisigOpen && (
        <MultisigCreateModal
          open={true}
          vaultsCount={vaults?.length ?? 0}
          onClose={handleMultisigCancel}
          onComplete={() => void handleMultisigComplete()}
        />
      )}
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
            display: "flex",
            gap: 6,
            alignItems: "center",
            minWidth: 0,
          }}
          title={vault.label}
        >
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--fg-100)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {vault.label}
          </div>
          {vault.kind === "multisig" && (
            <span
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 9.5,
                padding: "1px 5px",
                borderRadius: 4,
                border: "1px solid rgba(124,127,255,0.4)",
                background: "rgba(124,127,255,0.08)",
                color: "var(--fg-200)",
                letterSpacing: "0.06em",
                flexShrink: 0,
              }}
              title={`${vault.threshold} of ${vault.signerCount} multisig${
                vault.pendingCount > 0
                  ? ` · ${vault.pendingCount} pending`
                  : ""
              }`}
            >
              {vault.threshold}/{vault.signerCount}
              {vault.pendingCount > 0 ? ` · ${vault.pendingCount}p` : ""}
            </span>
          )}
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
