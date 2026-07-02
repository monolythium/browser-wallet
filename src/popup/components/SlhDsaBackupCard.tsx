// Settings → Security backup card.
//
// Encapsulates the full §30.1 backup lifecycle UX inside one
// component:
//
//   - read backup state on mount + on `vaultId` change
//   - render four primary states + the registration sub-states
//     (pending, registration-failed)
//   - launch the reveal modal in generate vs re-export modes
//   - submit the on-chain registration via the orchestrator
//   - poll the registration tx receipt while status === "pending"
//   - confirm + clear with a destructive-action explainer
//
// Lives as a separate component so the existing Security page
// keeps its passkey card uncluttered.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import {
  bgSlhDsaBackupClear,
  bgSlhDsaBackupGet,
  bgSlhDsaBackupPollReceipt,
  bgSlhDsaBackupSetRegistrationStatus,
  bgSlhDsaBackupSubmitRegistration,
} from "../bg";
import { ExternalLink } from "./ExternalLink";
import { SlhDsaBackupRevealModal } from "./SlhDsaBackupRevealModal";
import { SlhDsaRotationRehearsal } from "./SlhDsaRotationRehearsal";
import {
  type SlhDsaBackup,
  backupStatusLabel,
  clearAbandonsOnChainKey,
  isBackupComplete,
} from "../../shared/slh-dsa-backup.js";
import { monoscanTxUrl } from "../../shared/build-info";

/** Receipt poll cadence + max-duration. Keep small so a popup
 *  that's been left open briefly catches the registration; abort
 *  after the max so we don't hammer the SW for hours. The user
 *  can manually re-trigger polling by reopening Settings. */
const RECEIPT_POLL_INTERVAL_MS = 5_000;
const RECEIPT_POLL_MAX_MS = 5 * 60_000; // 5 minutes

export interface SlhDsaBackupCardProps {
  vaultId: string;
  /** Active chain id (hex). Required for the registration tx
   *  submit path. */
  chainIdHex: string;
}

type ConfirmingClear = "idle" | "asking" | "clearing";

export function SlhDsaBackupCard({
  vaultId,
  chainIdHex,
}: SlhDsaBackupCardProps) {
  const [backup, setBackup] = useState<SlhDsaBackup | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [revealOpen, setRevealOpen] = useState<
    "generate" | "re-export" | null
  >(null);
  const [confirmingClear, setConfirmingClear] =
    useState<ConfirmingClear>("idle");
  const [clearPassword, setClearPassword] = useState("");
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearAck, setClearAck] = useState(false);

  // Clearing a `registered` (or in-flight `pending`) backup abandons the
  // one-time-per-account on-chain key — high-friction path (hard warning +
  // explicit ack gating the password + a Re-export steer).
  const clearRequiresAck =
    backup !== null && clearAbandonsOnChainKey(backup.chainRegistrationStatus);
  const pollStartRef = useRef<number | null>(null);

  const refresh = async () => {
    setLoadErr(null);
    const r = await bgSlhDsaBackupGet(vaultId);
    if (r.ok) setBackup(r.backup);
    else setLoadErr(r.reason);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  // Poll the receipt while the registration is pending. Cancel on
  // unmount, on state change away from pending, and after the max
  // duration elapses.
  useEffect(() => {
    if (!backup || backup.chainRegistrationStatus !== "pending") {
      pollStartRef.current = null;
      return;
    }
    if (typeof backup.chainRegistrationTxHash !== "string") return;
    const txHash = backup.chainRegistrationTxHash;
    if (pollStartRef.current === null) {
      pollStartRef.current = Date.now();
    }
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      if (
        pollStartRef.current !== null &&
        Date.now() - pollStartRef.current > RECEIPT_POLL_MAX_MS
      ) {
        clearInterval(interval);
        return;
      }
      void (async () => {
        const r = await bgSlhDsaBackupPollReceipt(txHash);
        if (cancelled) return;
        if (!r.ok || !r.receipt) return;
        // 0x1 = success, anything else = revert. eth_getTransactionReceipt
        // emits `status` lowercase-hex; tolerate both upper + lower
        // by comparing parsed ints.
        const statusInt = r.receipt.status
          ? parseInt(r.receipt.status, 16)
          : -1;
        const blockInt = r.receipt.blockNumber
          ? parseInt(r.receipt.blockNumber, 16)
          : null;
        if (statusInt === 1) {
          await bgSlhDsaBackupSetRegistrationStatus({
            vaultId,
            status: "registered",
            ...(blockInt !== null ? { block: blockInt } : {}),
          });
        } else if (statusInt === 0) {
          await bgSlhDsaBackupSetRegistrationStatus({
            vaultId,
            status: "registration-failed",
            error: "Chain reverted the registration tx",
          });
        } else {
          return;
        }
        await refresh();
        clearInterval(interval);
      })();
    }, RECEIPT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, backup?.chainRegistrationStatus, backup?.chainRegistrationTxHash]);

  const handleRegisterOnChain = async () => {
    if (!backup || backup.publicKey === "") return;
    setSubmitting(true);
    setSubmitErr(null);
    const r = await bgSlhDsaBackupSubmitRegistration({
      vaultId,
      publicKeyHex: backup.publicKey,
      chainIdHex,
    });
    if (!r.ok) setSubmitErr(r.reason);
    setSubmitting(false);
    await refresh();
  };

  const resetClearFlow = () => {
    setConfirmingClear("idle");
    setClearPassword("");
    setClearError(null);
    setClearAck(false);
  };

  const handleClearConfirmed = async () => {
    if (clearRequiresAck && !clearAck) {
      setClearError(
        "Acknowledge that this abandons emergency recovery to continue.",
      );
      return;
    }
    if (clearPassword.length === 0) {
      setClearError("Enter your password to confirm.");
      return;
    }
    setConfirmingClear("clearing");
    setClearError(null);
    const r = await bgSlhDsaBackupClear(vaultId, clearPassword);
    if (!r.ok) {
      // Stay on the confirm step so the user can retry; surface the reason.
      setConfirmingClear("asking");
      const secs = r.secondsRemaining ?? 0;
      setClearError(
        r.reason === "wrong_password"
          ? secs > 0
            ? `Incorrect password. Try again in ${secs}s.`
            : "Incorrect password."
          : r.reason === "locked_out"
            ? `Too many attempts. Try again in ${secs}s.`
            : r.reason === "missing password"
              ? "Enter your password to confirm."
              : r.reason,
      );
      return;
    }
    setClearPassword("");
    setConfirmingClear("idle");
    await refresh();
  };

  return (
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
        A separate backup key, in a different cryptographic family, that
        protects your funds if your main signature scheme is ever broken.
      </div>

      {loadErr && <div style={errBox}>Could not load: {loadErr}</div>}

      {/* `BackupStateRow` always renders so the user
          sees the current state pill even for a fresh vault (label =
          "Not set up"). Previously the entire action area was wrapped
          in `{backup && ...}`, which hid the primary CTA when backup
          was null — fresh vaults saw only the card header + description
          text and reported "appears as placeholder text only". */}
      <BackupStateRow backup={backup} />

      {/* Action area — drives off the current state. The "Set up" CTA
          fires when backup is null OR backup.createdAt is 0 (vault
          opted in but generation didn't complete). All other action
          surfaces live below, gated on `backup.createdAt > 0`. */}
      {(!backup || backup.createdAt === 0) && (
        <button
          onClick={() => setRevealOpen("generate")}
          style={btnPrimaryFull}
        >
          <Icon name="shield" size={12} /> Set up emergency recovery key
        </button>
      )}

      {backup && (
        <>
          {backup.createdAt > 0 && (
            <>
              {/* "Locally generated" state */}
              {backup.chainRegistrationStatus === "not-registered" && (
                <>
                  {!backup.coldStorageConfirmed ? (
                    <>
                      <div
                        style={{
                          ...infoBox,
                          marginTop: 4,
                          marginBottom: 8,
                          color: "var(--gold)",
                        }}
                      >
                        You haven't confirmed cold storage yet. Re-open the
                        reveal flow to record the mnemonic on paper.
                      </div>
                      <button
                        onClick={() => setRevealOpen("re-export")}
                        style={btnPrimaryFull}
                      >
                        <Icon name="eye" size={12} /> Show backup mnemonic
                      </button>
                    </>
                  ) : (
                    <>
                      <div
                        style={{
                          ...infoBox,
                          marginTop: 4,
                          marginBottom: 8,
                          color: "var(--fg-300)",
                        }}
                      >
                        Backup is on disk + cold-storage confirmed. Register
                        the public half on chain to anchor the emergency
                        rotation slot — one tx, one-time per address.
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => setRevealOpen("re-export")}
                          style={btnGhostFlex}
                        >
                          Re-export
                        </button>
                        <button
                          onClick={() => void handleRegisterOnChain()}
                          disabled={submitting}
                          style={{
                            ...btnPrimaryFlex,
                            opacity: submitting ? 0.5 : 1,
                          }}
                        >
                          {submitting ? "Submitting…" : "Register on chain"}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}

              {backup.chainRegistrationStatus === "pending" && (
                <>
                  <div
                    style={{
                      ...infoBox,
                      marginTop: 4,
                      marginBottom: 8,
                      color: "var(--gold)",
                    }}
                  >
                    Registration tx submitted. Waiting for inclusion (this
                    page polls every 5 s).
                  </div>
                  {backup.chainRegistrationTxHash && (
                    <div style={txHashStyle}>
                      tx:{" "}
                      <ExternalLink
                        href={monoscanTxUrl(backup.chainRegistrationTxHash)}
                        title={backup.chainRegistrationTxHash}
                        style={{ fontFamily: "var(--f-mono)" }}
                      >
                        {backup.chainRegistrationTxHash}
                      </ExternalLink>
                    </div>
                  )}
                  <button
                    onClick={() => setRevealOpen("re-export")}
                    style={btnGhostFull}
                  >
                    Re-export backup mnemonic
                  </button>
                </>
              )}

              {backup.chainRegistrationStatus === "registered" && (
                <>
                  <div
                    style={{
                      ...infoBox,
                      marginTop: 4,
                      marginBottom: 8,
                      color: "var(--ok, #7ee3c1)",
                      borderColor: "rgba(126,227,193,0.4)",
                      background: "rgba(126,227,193,0.08)",
                    }}
                  >
                    Backup is registered on chain. Emergency rotation is
                    armed; your cold-storage mnemonic is what activates it
                    if a G3 declaration ever lands.
                  </div>
                  {backup.chainRegistrationBlock !== undefined && (
                    <div style={txHashStyle}>
                      Block {backup.chainRegistrationBlock}
                      {backup.chainRegistrationTxHash && (
                        <>
                          {" · tx "}
                          <ExternalLink
                            href={monoscanTxUrl(backup.chainRegistrationTxHash)}
                            title={backup.chainRegistrationTxHash}
                            style={{ fontFamily: "var(--f-mono)" }}
                          >
                            {backup.chainRegistrationTxHash}
                          </ExternalLink>
                        </>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => setRevealOpen("re-export")}
                    style={btnGhostFull}
                  >
                    Re-export backup mnemonic
                  </button>
                </>
              )}

              {backup.chainRegistrationStatus === "registration-failed" && (
                <>
                  <div style={errBox}>
                    Registration failed:{" "}
                    {backup.chainRegistrationError ?? "Unknown error"}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      onClick={() => setRevealOpen("re-export")}
                      style={btnGhostFlex}
                    >
                      Re-export
                    </button>
                    <button
                      onClick={() => void handleRegisterOnChain()}
                      disabled={submitting}
                      style={{
                        ...btnPrimaryFlex,
                        opacity: submitting ? 0.5 : 1,
                      }}
                    >
                      Retry registration
                    </button>
                  </div>
                </>
              )}

              {submitErr && (
                <div style={{ ...errBox, marginTop: 8 }}>{submitErr}</div>
              )}

              {/* Destructive — abandon + regenerate. */}
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: "1px solid var(--fg-700)",
                }}
              >
                {confirmingClear === "idle" && (
                  <button
                    onClick={() => setConfirmingClear("asking")}
                    style={btnDangerGhost}
                  >
                    Generate a new backup key…
                  </button>
                )}
                {confirmingClear === "asking" && (
                  <>
                    {clearRequiresAck ? (
                      <>
                        <div
                          style={{
                            ...errBox,
                            marginBottom: 8,
                            color: "var(--fg-100)",
                          }}
                        >
                          <strong>
                            Clearing does not remove the on-chain registration.
                          </strong>{" "}
                          Registration is permanent and one-time per account —
                          if you clear this backup,{" "}
                          <strong>
                            this account can never register a new emergency
                            recovery key
                          </strong>
                          , and the key already on chain becomes permanently
                          unusable (its secret is discarded). If you only need
                          to write your recovery phrase down again, use
                          Re-export instead. Continue only if you have
                          deliberately decided to abandon emergency recovery for
                          this account.
                        </div>
                        <button
                          onClick={() => {
                            resetClearFlow();
                            setRevealOpen("re-export");
                          }}
                          style={btnPrimaryFull}
                        >
                          <Icon name="eye" size={12} /> Re-export instead
                          (recommended)
                        </button>
                        <label
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 8,
                            margin: "10px 0 2px",
                            fontSize: 11,
                            color: "var(--fg-100)",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={clearAck}
                            onChange={(e) => setClearAck(e.target.checked)}
                            style={{ marginTop: 2 }}
                          />
                          <span>
                            I understand this permanently abandons emergency
                            recovery for this account and cannot be undone.
                          </span>
                        </label>
                      </>
                    ) : (
                      <div
                        style={{
                          ...errBox,
                          marginBottom: 8,
                          color: "var(--fg-100)",
                        }}
                      >
                        This discards your local emergency backup. You'll
                        generate a new 24-word phrase and write it down again.
                      </div>
                    )}
                    <input
                      type="password"
                      value={clearPassword}
                      onChange={(e) => setClearPassword(e.target.value)}
                      placeholder="Enter your password to confirm"
                      autoComplete="current-password"
                      disabled={clearRequiresAck && !clearAck}
                      style={{
                        ...clearPasswordInput,
                        marginTop: 8,
                        opacity: clearRequiresAck && !clearAck ? 0.5 : 1,
                      }}
                    />
                    {clearError && (
                      <div style={{ ...errBox, marginTop: 8 }}>{clearError}</div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={resetClearFlow} style={btnGhostFlex}>
                        Cancel
                      </button>
                      <button
                        onClick={() => void handleClearConfirmed()}
                        disabled={
                          clearPassword.length === 0 ||
                          (clearRequiresAck && !clearAck)
                        }
                        style={{
                          ...btnDangerFlex,
                          opacity:
                            clearPassword.length === 0 ||
                            (clearRequiresAck && !clearAck)
                              ? 0.5
                              : 1,
                        }}
                      >
                        Clear local backup
                      </button>
                    </div>
                  </>
                )}
                {confirmingClear === "clearing" && (
                  <div style={{ fontSize: 11, color: "var(--fg-400)" }}>
                    Clearing…
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* G3 rotation rehearsal (§30.2) demoted to
          a collapsed-by-default reference block that surfaces for ALL
          states, including fresh vaults. The user wanted to read about
          the emergency-rotation flow BEFORE committing to setup, which
          the previous "only show after backup exists" placement
          prevented. The block is visually muted vs the primary card
          chrome via SlhDsaRotationRehearsal's own styling. */}
      <SlhDsaRotationRehearsal />

      {revealOpen !== null && (
        <SlhDsaBackupRevealModal
          open={revealOpen !== null}
          mode={revealOpen}
          vaultId={vaultId}
          onClose={() => setRevealOpen(null)}
          onConfirmed={() => {
            setRevealOpen(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function BackupStateRow({ backup }: { backup: SlhDsaBackup | null }) {
  // Null-safe state row. backupStatusLabel already
  // returns "Not set up" for null/undefined; this row renders the same
  // pill shape so the layout doesn't shift between "not set up" and
  // "locally generated" states.
  const label = backupStatusLabel(backup);
  const complete = backup !== null && isBackupComplete(backup);
  const tone = complete
    ? { color: "var(--ok, #7ee3c1)", border: "rgba(126,227,193,0.4)" }
    : backup !== null && backup.chainRegistrationStatus === "registration-failed"
      ? { color: "var(--err)", border: "rgba(220,80,80,0.4)" }
      : { color: "var(--fg-100)", border: "var(--fg-700)" };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 10px",
        borderRadius: 8,
        border: `1px solid ${tone.border}`,
        background: "rgba(255,255,255,0.04)",
        marginBottom: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: tone.color }}>
          {label}
        </div>
        {backup && backup.createdAt > 0 && (
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-400)",
              marginTop: 2,
              fontFamily: "var(--f-mono)",
            }}
          >
            Algo: SLH-DSA-SHA2-128s · created{" "}
            {new Date(backup.createdAt).toLocaleDateString()}
          </div>
        )}
        {backup === null && (
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-400)",
              marginTop: 2,
              fontFamily: "var(--f-mono)",
            }}
          >
            Algo: SLH-DSA-SHA2-128s · {`NIST FIPS 205 (hash-based)`}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Styles
// ────────────────────────────────────────────────────────────────────────────

const errBox: CSSProperties = {
  fontSize: 11,
  color: "var(--err)",
  padding: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  borderRadius: 8,
  background: "rgba(220,80,80,0.08)",
  lineHeight: 1.5,
};

const clearPasswordInput: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
};

const infoBox: CSSProperties = {
  fontSize: 11,
  padding: 8,
  border: "1px solid rgba(244,201,122,0.4)",
  borderRadius: 8,
  background: "rgba(244,201,122,0.06)",
  lineHeight: 1.5,
};

const txHashStyle: CSSProperties = {
  fontSize: 10.5,
  color: "var(--fg-400)",
  fontFamily: "var(--f-mono)",
  marginBottom: 8,
};

const btnPrimaryFull: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
};

const btnGhostFull: CSSProperties = {
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
};

const btnGhostFlex: CSSProperties = {
  flex: 1,
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};

const btnPrimaryFlex: CSSProperties = {
  flex: 1,
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const btnDangerGhost: CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(220,80,80,0.4)",
  background: "rgba(220,80,80,0.06)",
  color: "var(--err)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  cursor: "pointer",
};

const btnDangerFlex: CSSProperties = {
  flex: 1,
  padding: "9px 10px",
  borderRadius: 8,
  border: "1px solid var(--err)",
  background: "rgba(220,80,80,0.12)",
  color: "var(--err)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
