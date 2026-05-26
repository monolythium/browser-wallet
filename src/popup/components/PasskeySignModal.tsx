// Phase 9 Commit 4 — PasskeySignModal.
//
// Runs `navigator.credentials.get()` with a tx-hash-bound challenge
// when the Send flow's policy evaluation says `passkey-ok`. The modal
// is a UX-layer presence gate: a successful WebAuthn assertion is
// proof that the user has access to the registered passkey, and the
// wallet treats that as authorisation for the small-value tx without
// re-prompting for password.
//
// The wallet does NOT cryptographically verify the WebAuthn signature
// here — the browser's WebAuthn implementation is the verifier. We
// trust the runtime to refuse to return an assertion unless the
// authenticator actually approved it. (When the chain ships a
// passkey precompile, this will evolve: the wallet will collect the
// assertion bytes and ship them on chain alongside the ML-DSA
// signature.)
//
// Challenge construction: deterministic hash of (domain, tx fields,
// nonce). Domain separation prevents an assertion captured here from
// being replayed against an unrelated wallet using the same
// authenticator.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Modal } from "./Modal";
import { buildPasskeyChallenge } from "../../shared/passkey";
import type { BgPasskeyCredential } from "../bg";

export interface PasskeySignModalProps {
  open: boolean;
  /** Active vault address — surfaces inside the prompt copy. */
  vaultAddress: string;
  /** Active credentials list — the modal builds
   *  `allowCredentials[]` from these so the authenticator knows which
   *  registered key to use. */
  credentials: BgPasskeyCredential[];
  /** Deterministic tx digest (32 bytes) for the challenge. Caller is
   *  the Send flow; it should pass the same digest the chain will
   *  see (txHash) so a future on-chain passkey precompile can
   *  cross-check. */
  txDigest: Uint8Array;
  /** Dismiss without proceeding. */
  onCancel: () => void;
  /** Assertion succeeded — caller proceeds with the tx submit. */
  onSuccess: () => void;
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
  txDigest,
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
      const nonce = crypto.getRandomValues(
        new Uint8Array(new ArrayBuffer(16)),
      );
      const challenge = buildPasskeyChallenge(txDigest, nonce);
      const allowCredentials = credentials.map((c) => ({
        type: "public-key" as const,
        id: base64UrlToBytes(c.credentialId),
      }));
      const opts: CredentialRequestOptions = {
        publicKey: {
          challenge: toBufferSource(challenge),
          allowCredentials,
          userVerification: "preferred",
          timeout: 60_000,
        },
      };
      const cred = (await navigator.credentials.get(opts)) as PublicKeyCredential | null;
      if (!cred) {
        setScreen({ kind: "error", message: "Authentication cancelled" });
        return;
      }
      // We don't verify the signature on the wallet side — the
      // browser's WebAuthn implementation already enforces presence
      // / user-verification. The fact that .get() resolved IS the
      // assertion.
      onSuccess();
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
