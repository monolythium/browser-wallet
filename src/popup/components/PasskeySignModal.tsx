// PasskeySignModal.
//
// Runs `navigator.credentials.get()` with the SERVICE-WORKER-ISSUED,
// tx-intent-bound challenge when the Send flow's policy evaluation says
// `passkey-ok` (boundary 3b). The popup no longer builds its own challenge:
// the SW mints a single-use challenge at `passkey-evaluate`, the popup runs the
// ceremony over it, and forwards the resulting assertion bytes back to the SW,
// which CRYPTOGRAPHICALLY VERIFIES the assertion (origin, rpId, challenge,
// signature, signCount) before signing. A successful `.get()` here is no longer
// trusted on its own — it is only the collection step.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Modal } from "./Modal";
import { PASSKEY_USER_VERIFICATION } from "../../shared/passkey";
import type { BgForwardedAssertion, BgPasskeyCredential } from "../bg";

export interface PasskeySignModalProps {
  open: boolean;
  /** Active vault address — surfaces inside the prompt copy. */
  vaultAddress: string;
  /** Active credentials list — the modal builds
   *  `allowCredentials[]` from these so the authenticator knows which
   *  registered key to use. */
  credentials: BgPasskeyCredential[];
  /** The SW-issued challenge (base64url) the ceremony must sign over. The
   *  popup uses this verbatim — it never mints its own challenge (3b). */
  challengeB64: string;
  /** Dismiss without proceeding. */
  onCancel: () => void;
  /** Assertion collected — caller forwards it to the SW verify gate, which
   *  decides whether to sign. */
  onSuccess: (assertion: BgForwardedAssertion) => void;
}

type ScreenState =
  | { kind: "prompting" }
  | { kind: "error"; message: string };

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(norm);
  const buf = new ArrayBuffer(bin.length);
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function bytesToBase64Url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toBufferSource(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  // The DOM `BufferSource` requires `Uint8Array<ArrayBuffer>` (not the
  // `<ArrayBufferLike>` generic). Allocate a fresh ArrayBuffer-backed
  // copy so the value flows cleanly.
  const buf = new ArrayBuffer(u8.length);
  const copy = new Uint8Array(buf);
  copy.set(u8);
  return copy;
}

function describeWebAuthnError(e: DOMException | Error): string {
  if ("name" in e && typeof e.name === "string") {
    switch (e.name) {
      case "NotAllowedError":
        return "Cancelled or timed out — password unlock still works";
      case "NotSupportedError":
        return "No registered authenticator responded";
      case "InvalidStateError":
        return "Authenticator state error";
      case "SecurityError":
        return "Page origin does not satisfy WebAuthn requirements";
      case "AbortError":
        return "Authentication aborted";
    }
  }
  return e.message || "Unknown authentication error";
}

export function PasskeySignModal({
  open,
  vaultAddress,
  credentials,
  challengeB64,
  onCancel,
  onSuccess,
}: PasskeySignModalProps) {
  const [screen, setScreen] = useState<ScreenState>({ kind: "prompting" });
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined" &&
    typeof navigator.credentials.get === "function";

  useEffect(() => {
    if (!open) return;
    if (!supported) {
      setScreen({
        kind: "error",
        message: "Your browser does not support WebAuthn — use password",
      });
      return;
    }
    if (credentials.length === 0) {
      setScreen({
        kind: "error",
        message: "No passkeys registered for this wallet",
      });
      return;
    }

    setScreen({ kind: "prompting" });
    void runAssertion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const runAssertion = async () => {
    try {
      // Use the SW-issued challenge verbatim — the popup no longer mints one.
      const challenge = base64UrlToBytes(challengeB64);
      const allowCredentials = credentials.map((c) => ({
        type: "public-key" as const,
        id: base64UrlToBytes(c.credentialId),
      }));
      const opts: CredentialRequestOptions = {
        publicKey: {
          challenge: toBufferSource(challenge),
          allowCredentials,
          userVerification: PASSKEY_USER_VERIFICATION,
          timeout: 60_000,
        },
      };
      const cred = (await navigator.credentials.get(opts)) as PublicKeyCredential | null;
      if (!cred) {
        setScreen({ kind: "error", message: "Authentication cancelled" });
        return;
      }
      // Collect the assertion bytes and forward them — the SW
      // cryptographically verifies the signature before signing. A resolved
      // `.get()` is NOT treated as authorization on its own anymore.
      const resp = cred.response as AuthenticatorAssertionResponse;
      onSuccess({
        credentialId: bytesToBase64Url(new Uint8Array(cred.rawId)),
        authenticatorData: bytesToBase64Url(new Uint8Array(resp.authenticatorData)),
        clientDataJSON: bytesToBase64Url(new Uint8Array(resp.clientDataJSON)),
        signature: bytesToBase64Url(new Uint8Array(resp.signature)),
      });
    } catch (e) {
      const err = e as DOMException | Error;
      setScreen({ kind: "error", message: describeWebAuthnError(err) });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Confirm with passkey"
    >
      {screen.kind === "prompting" && (
        <>
          <div
            style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.5 }}
          >
            Approve the prompt from your authenticator to send this small-value
            transaction. The wallet uses your passkey as a fast-unlock shortcut
            in place of typing your password.
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: "var(--fg-400)",
              fontFamily: "var(--f-mono)",
              marginTop: 6,
            }}
          >
            Vault: {vaultAddress.slice(0, 8)}…{vaultAddress.slice(-6)}
          </div>
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--f-mono)",
              color: "var(--gold)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginTop: 10,
              textAlign: "center",
            }}
          >
            Awaiting authenticator…
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onCancel} style={btnGhost}>
              Cancel
            </button>
          </div>
        </>
      )}

      {screen.kind === "error" && (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--err)",
              lineHeight: 1.5,
              padding: 8,
              border: "1px solid rgba(220,80,80,0.4)",
              borderRadius: 8,
              background: "rgba(220,80,80,0.08)",
            }}
          >
            {screen.message}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 8,
            }}
          >
            <button onClick={onCancel} style={btnGhost}>
              Use password instead
            </button>
            <button
              onClick={() => {
                setScreen({ kind: "prompting" });
                void runAssertion();
              }}
              style={btnPrimary}
            >
              Try again
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

const btnGhost: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};

const btnPrimary: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--gold)",
  background: "var(--gold-bg)",
  color: "var(--gold)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
