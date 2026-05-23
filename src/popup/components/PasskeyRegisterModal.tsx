// Phase 9 Commit 2 — PasskeyRegisterModal.
//
// Drives the `navigator.credentials.create()` WebAuthn registration
// inside the popup window context. MV3 service workers cannot invoke
// WebAuthn (no DOM, no user gesture), so the call has to live in this
// component. The resulting `credentialId` + user-edited name + the
// authenticator class get persisted via `passkey-add-credential` IPC.
//
// What WebAuthn sees
// ==================
// We pass an `rp` object identifying the wallet extension origin, a
// per-user `user` block tied to the active vault address, and a fresh
// 32-byte challenge derived from a random nonce (no tx hash for the
// registration call — the challenge is used only for replay defense
// on the registration assertion, not on a tx). `pubKeyCredParams`
// lists ES256 + RS256 to maximise authenticator compatibility while
// keeping the algorithm set small and well-understood.
//
// The wallet does NOT consume the returned public key. WebAuthn keeps
// the private key on the authenticator; the wallet only needs the
// `rawId` (base64-encoded) so it can pass it back as
// `allowCredentials[].id` on future `.get()` calls.
//
// Failure modes
// =============
// - User cancels the authenticator prompt: shown as "Cancelled by
//   user — try again or pick a different authenticator".
// - Authenticator not available (no Windows Hello, no Touch ID, no
//   security key): shown as "No compatible authenticator found".
// - `navigator.credentials` undefined (very old browser): rejected at
//   modal open with a "Your browser does not support passkeys" notice.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import {
  bgPasskeyAddCredential,
  type BgAuthenticatorKind,
  type BgPasskeyState,
} from "../bg";

export interface PasskeyRegisterModalProps {
  open: boolean;
  /** Active vault id — the credential persists into this vault's
   *  passkey state. */
  vaultId: string;
  /** Active vault address — surfaced inside the WebAuthn `user` block
   *  so the OS / authenticator can show "registering passkey for
   *  0xabc…1234" in its native UI. */
  vaultAddress: string;
  /** Dismiss without committing. */
  onClose: () => void;
  /** Successful registration — caller refreshes Security page state. */
  onRegistered: (state: BgPasskeyState) => void;
}

type ScreenState =
  | { kind: "form" }
  | { kind: "registering" }
  | { kind: "error"; message: string }
  | { kind: "done" };

function bytesToBase64Url(b: ArrayBuffer | Uint8Array): string {
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strHash(seed: string): Uint8Array<ArrayBuffer> {
  // Tiny deterministic id derived from the vault address. WebAuthn's
  // `user.id` is opaque to the authenticator but should be stable per
  // user identity; using the vault address keeps "the same vault"
  // recognizable across re-registrations without leaking anything the
  // address itself doesn't already expose.
  const enc = new TextEncoder().encode(seed);
  // 32 bytes is the upper bound the WebAuthn spec permits for user.id.
  // Allocated over a fresh `ArrayBuffer` (not `ArrayBufferLike`, which
  // includes SharedArrayBuffer) so the value satisfies the DOM
  // `BufferSource` type used by `PublicKeyCredentialUserEntity.id`.
  const buf = new ArrayBuffer(32);
  const out = new Uint8Array(buf);
  for (let i = 0; i < enc.length && i < 32; i++) out[i] = enc[i]!;
  return out as Uint8Array<ArrayBuffer>;
}

export function PasskeyRegisterModal({
  open,
  vaultId,
  vaultAddress,
  onClose,
  onRegistered,
}: PasskeyRegisterModalProps) {
  const [name, setName] = useState("Primary passkey");
  const [kind, setKind] = useState<BgAuthenticatorKind>("platform");
  const [screen, setScreen] = useState<ScreenState>({ kind: "form" });
  const supported =
    typeof navigator !== "undefined" &&
    typeof navigator.credentials !== "undefined" &&
    typeof navigator.credentials.create === "function";

  useEffect(() => {
    if (!open) {
      // Reset on close so a re-open starts fresh.
      setName("Primary passkey");
      setKind("platform");
      setScreen({ kind: "form" });
    }
  }, [open]);

  if (!supported && open) {
    return (
      <Modal open={open} onClose={onClose} title="Register a passkey">
        <div style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.5 }}>
          Your browser does not support WebAuthn / passkeys. Phase 9's
          fast-unlock surface requires a browser with{" "}
          <code>navigator.credentials</code> support — Chrome 67+, Firefox 60+,
          Edge 18+, or Safari 13+.
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={onClose} style={btnGhost}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  const handleRegister = async () => {
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 64) {
      setScreen({ kind: "error", message: "Name must be 1-64 characters" });
      return;
    }

    setScreen({ kind: "registering" });

    let credentialId: string;
    try {
      // Use a freshly-allocated ArrayBuffer-backed Uint8Array so the
      // DOM `BufferSource` constraint accepts the value — `Uint8Array
      // <ArrayBufferLike>` (which includes the SharedArrayBuffer
      // variant) is not assignable to `BufferSource` under TS strict
      // checks. `crypto.getRandomValues` mutates in-place; we feed it
      // the fresh buffer.
      const challenge = crypto.getRandomValues(
        new Uint8Array(new ArrayBuffer(32)),
      );
      const userId = strHash(vaultAddress.toLowerCase());

      const opts: CredentialCreationOptions = {
        publicKey: {
          challenge,
          rp: {
            // `name` shows up in the OS authenticator prompt. Keep it
            // short and unambiguous so the user knows which wallet
            // they're registering for.
            name: "Monolythium Wallet",
          },
          user: {
            id: userId,
            name: vaultAddress,
            displayName: vaultAddress,
          },
          // ES256 first (most platform authenticators); RS256 as a
          // fallback for older security keys. The wallet never
          // consumes the public key, but WebAuthn requires the field.
          pubKeyCredParams: [
            { type: "public-key", alg: -7 }, // ES256
            { type: "public-key", alg: -257 }, // RS256
          ],
          authenticatorSelection: {
            authenticatorAttachment:
              kind === "platform" ? "platform" : "cross-platform",
            userVerification: "preferred",
            // Non-resident keys — the wallet remembers
            // `allowCredentials[].id` itself on future `.get()` calls.
            residentKey: "discouraged",
            requireResidentKey: false,
          },
          // 60 s upper bound — long enough for the user to actually
          // tap the security key / authorise via biometric, short
          // enough that an idle prompt times out cleanly.
          timeout: 60_000,
          attestation: "none",
        },
      };

      const cred = (await navigator.credentials.create(opts)) as PublicKeyCredential | null;
      if (!cred) {
        setScreen({ kind: "error", message: "Registration cancelled" });
        return;
      }
      credentialId = bytesToBase64Url(cred.rawId);
    } catch (e) {
      const err = e as DOMException | Error;
      const msg = describeWebAuthnError(err);
      setScreen({ kind: "error", message: msg });
      return;
    }

    // Persist via SW IPC.
    const res = await bgPasskeyAddCredential({
      vaultId,
      credential: {
        credentialId,
        name: trimmed,
        kind,
        createdAt: Date.now(),
      },
    });
    if (!res.ok) {
      setScreen({ kind: "error", message: `Could not save: ${res.reason}` });
      return;
    }
    setScreen({ kind: "done" });
    onRegistered(res.state);
  };

  return (
    <Modal open={open} onClose={onClose} title="Register a passkey">
      {screen.kind === "form" && (
        <>
          <div style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.5 }}>
            Register a Windows Hello, Touch ID, or security-key passkey so the
            wallet can ask for it instead of your password on small-value
            transfers. The private key never leaves the authenticator. The
            wallet only stores the public credential ID.
          </div>

          <label style={{ display: "block", marginTop: 8 }}>
            <div style={labelLabel}>Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              style={inputStyle}
              placeholder="e.g. Office YubiKey"
            />
          </label>

          <div style={{ display: "block", marginTop: 8 }}>
            <div style={labelLabel}>Authenticator</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {(["platform", "cross-platform"] as const).map((k) => {
                const active = kind === k;
                return (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    style={{
                      ...kindBtn,
                      borderColor: active
                        ? "var(--gold)"
                        : "var(--fg-700)",
                      background: active
                        ? "var(--gold-bg)"
                        : "rgba(255,255,255,0.04)",
                      color: active ? "var(--gold)" : "var(--fg-100)",
                    }}
                  >
                    {k === "platform" ? "Platform" : "Security key"}
                    <div style={kindBtnHint}>
                      {k === "platform"
                        ? "Touch ID / Windows Hello"
                        : "YubiKey / hardware"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 8,
              marginTop: 10,
            }}
          >
            <button onClick={onClose} style={btnGhost}>
              Cancel
            </button>
            <button onClick={() => void handleRegister()} style={btnPrimary}>
              <Icon name="passkey" size={12} />
              Register
            </button>
          </div>
        </>
      )}

      {screen.kind === "registering" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: "12px 0",
          }}
        >
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--f-mono)",
              color: "var(--gold)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            Authorising…
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--fg-300)",
              textAlign: "center",
              lineHeight: 1.5,
            }}
          >
            Confirm the prompt from your authenticator. Touch the biometric
            sensor, type your device PIN, or tap your security key.
          </div>
        </div>
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
            <button onClick={onClose} style={btnGhost}>
              Close
            </button>
            <button onClick={() => setScreen({ kind: "form" })} style={btnPrimary}>
              Try again
            </button>
          </div>
        </>
      )}

      {screen.kind === "done" && (
        <>
          <div
            style={{
              fontSize: 11.5,
              color: "var(--ok, #7ee3c1)",
              lineHeight: 1.5,
              padding: 8,
              border: "1px solid rgba(126,227,193,0.4)",
              borderRadius: 8,
              background: "rgba(126,227,193,0.08)",
            }}
          >
            Passkey registered. Enable the policy on the Security page to
            start using it on small-value transfers.
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
            <button onClick={onClose} style={btnPrimary}>
              Done
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function describeWebAuthnError(e: DOMException | Error): string {
  if ("name" in e && typeof e.name === "string") {
    switch (e.name) {
      case "NotAllowedError":
        return "Cancelled or timed out — try again";
      case "NotSupportedError":
        return "No compatible authenticator found on this device";
      case "InvalidStateError":
        return "This authenticator is already registered for this vault";
      case "SecurityError":
        return "The page origin does not satisfy WebAuthn requirements";
      case "AbortError":
        return "Registration aborted";
    }
  }
  return e.message || "Unknown registration error";
}

const labelLabel: CSSProperties = {
  fontFamily: "var(--f-mono)",
  fontSize: 10,
  color: "var(--fg-400)",
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  marginBottom: 4,
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  boxSizing: "border-box",
};

const kindBtn: CSSProperties = {
  padding: "8px 8px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  cursor: "pointer",
  textAlign: "left",
  transition: "all 150ms var(--e-out)",
};

const kindBtnHint: CSSProperties = {
  fontSize: 10,
  marginTop: 2,
  color: "var(--fg-400)",
};

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
  display: "flex",
  alignItems: "center",
  gap: 6,
};
