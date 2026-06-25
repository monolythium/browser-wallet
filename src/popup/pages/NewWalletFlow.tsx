// In-app new wallet flow.
//
// Composed of the same ShowPhrase + VerifyPhrase components the
// first-setup onboarding renders, but in a SEPARATE navigation
// context: every step here has back/cancel allowed (unlike onboarding,
// where onboarding hides the back button on those two screens to
// prevent the user from escaping to home before verification). The
// two flows share the components, not the navigation logic — so
// changes to back-protection on the onboarding side don't ripple into
// the in-app side and vice versa.
//
// Lifecycle:
//   1. Mount → call bgVaultGenerateFreshMnemonic. Mnemonic lives in
//      React state only — never persisted before verify success.
//   2. Show step → ShowPhrase. Back cancels (discard mnemonic, exit).
//   3. Verify step → VerifyPhrase. Back returns to show-phrase.
//      Verify success → bgVaultAddImport(mnemonic, label) → set as
//      active via bgVaultSelect → return home.
//   4. Cancel + retry generates a NEW mnemonic (component remounts).
//
// Cleanup: unmount clears the mnemonic ref. JS can't deterministically
// zero strings, but releasing the reference is what we can do.

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { ShowPhrase } from "./ShowPhrase";
import { VerifyPhrase } from "./VerifyPhrase";
import {
  bgVaultAddImport,
  bgVaultGenerateFreshMnemonic,
  bgVaultSelect,
} from "../bg";

interface NewWalletFlowProps {
  /** User backed out of the flow — discard mnemonic, return to caller
   *  (typically home) without persisting a new wallet. */
  onCancel: () => void;
  /** Verify succeeded + commit landed. Caller switches active vault
   *  + routes home. The new vault's id is threaded back so the
   *  caller can refresh its vault summary state. */
  onComplete: (vaultId: string) => void;
}

type Step = "loading" | "show" | "verify" | "committing" | "error";

export function NewWalletFlow({ onCancel, onComplete }: NewWalletFlowProps) {
  const [step, setStep] = useState<Step>("loading");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Generate the mnemonic on mount. The SW requires an unlocked
  // container for this call — App.tsx only routes here from the
  // hamburger / VaultPicker which is rendered post-unlock, so the
  // precondition is naturally satisfied.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await bgVaultGenerateFreshMnemonic();
      if (cancelled) return;
      if (!r.ok) {
        setError(r.reason ?? "Could not generate mnemonic.");
        setStep("error");
        return;
      }
      setMnemonic(r.mnemonic);
      setStep("show");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Drop the mnemonic reference on unmount. JS can't zero strings
  // but releasing the React state slot is what we can do; the SW
  // also never re-generates the same mnemonic.
  useEffect(() => () => setMnemonic(null), []);

  const handleVerified = async () => {
    if (mnemonic === null) return;
    setStep("committing");
    setError(null);
    try {
      const r = await bgVaultAddImport(mnemonic);
      if (!r.ok) {
        setError(r.reason ?? "Could not commit new wallet.");
        setStep("error");
        return;
      }
      // Switch the active vault to the newly-
      // created one so the user lands on home with the new wallet
      // selected. bgVaultAddImport doesn't auto-switch.
      const selR = await bgVaultSelect(r.vaultId);
      if (!selR.ok) {
        // Commit succeeded; activation didn't. Surface the error but
        // don't roll back — the wallet IS in the container and the
        // user can switch to it via VaultPicker.
        setError(
          selR.reason
            ? `Wallet created but could not activate: ${selR.reason}`
            : "Wallet created but could not be activated.",
        );
        setStep("error");
        return;
      }
      onComplete(r.vaultId);
    } catch (e) {
      setError((e as Error).message ?? "Could not commit new wallet.");
      setStep("error");
    }
  };

  if (step === "loading") {
    return (
      <>
        <div className="ext-top">
          <button
            className="ext-iconbtn"
            onClick={onCancel}
            aria-label="Cancel"
          >
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
            New wallet
          </div>
          <div style={{ width: 36 }} />
        </div>
        <div
          className="ext-body"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-300)",
            fontSize: 13,
          }}
        >
          Generating…
        </div>
      </>
    );
  }

  if (step === "error") {
    return (
      <>
        <div className="ext-top">
          <button
            className="ext-iconbtn"
            onClick={onCancel}
            aria-label="Back"
          >
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
            New wallet
          </div>
          <div style={{ width: 36 }} />
        </div>
        <div
          className="ext-body"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            textAlign: "center",
            padding: "24px 24px",
          }}
        >
          <div style={{ fontSize: 44, lineHeight: 1 }} aria-hidden="true">
            ⚠️
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--fg-100)",
            }}
          >
            Could not create wallet
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              maxWidth: 280,
              fontFamily: "var(--f-mono)",
            }}
          >
            {error ?? "Unknown error."}
          </div>
        </div>
        <div
          className="req-foot"
          style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
        >
          <button className="prim" onClick={onCancel}>
            Back
          </button>
        </div>
      </>
    );
  }

  if (step === "committing") {
    return (
      <>
        <div className="ext-top">
          <div style={{ width: 36 }} />
          <div
            style={{
              flex: 1,
              fontSize: 15,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            New wallet
          </div>
          <div style={{ width: 36 }} />
        </div>
        <div
          className="ext-body"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--fg-300)",
            fontSize: 13,
          }}
        >
          Creating…
        </div>
      </>
    );
  }

  if (mnemonic === null) {
    // Defensive — should be unreachable since loading transitions
    // straight to "show" only when mnemonic is set.
    return null;
  }

  if (step === "show") {
    return (
      <ShowPhrase
        mnemonic={mnemonic}
        onConfirmed={() => setStep("verify")}
        onBack={onCancel}
      />
    );
  }

  // step === "verify"
  return (
    <VerifyPhrase
      mnemonic={mnemonic}
      onVerified={() => void handleVerified()}
      onBack={() => setStep("show")}
    />
  );
}
