import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { MnemonicGrid } from "../components/MnemonicGrid";
import { WalletLockLogo } from "../components/WalletLockLogo";
import { bgKeystoreExportSeed } from "../bg";
import {
  clearClipboardNow,
  copyWithAutoClear,
  flushClipboardAutoClear,
  formatPhraseForClipboard,
} from "../../lib/clipboard-with-clear";

interface RevealPhraseProps {
  /** Returns to Settings. Called on Cancel, on auto-hide expiry, and after
   *  the user closes the reveal screen. */
  onBack: () => void;
}

type Step = "reauth" | "warning" | "reveal";

const AUTO_HIDE_SECONDS = 30;
const CLIPBOARD_CLEAR_MS = 30_000;

export function RevealPhrase({ onBack }: RevealPhraseProps) {
  const [step, setStep] = useState<Step>("reauth");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [autoHideRemaining, setAutoHideRemaining] = useState(AUTO_HIDE_SECONDS);
  const [autoHideStarted, setAutoHideStarted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [clearState, setClearState] = useState<"idle" | "cleared" | "failed">(
    "idle",
  );
  // Tap-to-reveal toggle. `revealed` flips on click anywhere on the
  // grid/overlay click target; first transition to `true` arms the
  // sticky `autoHideStarted` flag below.
  const [revealed, setRevealed] = useState(false);

  // Lockout countdown — mirrors UnlockScreen.
  useEffect(() => {
    if (secondsRemaining <= 0) return;
    const t = setInterval(() => {
      setSecondsRemaining((s) => {
        const next = s - 1;
        if (next <= 0) {
          setError(null);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [secondsRemaining]);

  // Auto-hide countdown — starts on the FIRST successful hold-to-reveal
  // (autoHideStarted flag, set inside startHold) and ticks continuously
  // regardless of subsequent press/release cycles. Expiry routes back to
  // Settings via onBack.
  useEffect(() => {
    if (!autoHideStarted) return;
    const t = setInterval(() => {
      setAutoHideRemaining((s) => {
        const next = s - 1;
        if (next <= 0) {
          // Defer the parent nav so we don't setState mid-render.
          setTimeout(() => onBack(), 0);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [autoHideStarted, onBack]);

  // Cleanup on unmount: drop the mnemonic from React state and FLUSH the
  // shared clipboard auto-clear (best-effort wipe NOW). This screen
  // auto-hides after 30 s — which unmounts it — so a self-managed timer
  // would have been cancelled and left the copied phrase on the OS
  // clipboard; the flush wipes it on the way out instead. The mnemonic
  // string itself can't be deterministically zeroed in JS, but releasing
  // the reference is what we can do.
  useEffect(() => {
    return () => {
      setMnemonic(null);
      void flushClipboardAutoClear();
    };
  }, []);

  // Tap-to-reveal toggle. The first transition to revealed=true arms
  // the sticky 30s auto-hide (subsequent reveal/hide cycles don't reset
  // it — same semantics as the previous hold-to-reveal implementation).
  const toggleReveal = () => {
    setRevealed((r) => {
      if (!r) setAutoHideStarted(true);
      return !r;
    });
  };

  const handleAuthSubmit = async () => {
    if (submitting || secondsRemaining > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await bgKeystoreExportSeed(password);
      if (r.ok) {
        setMnemonic(r.mnemonic);
        setPassword("");
        setStep("warning");
        return;
      }
      const remaining =
        typeof r.secondsRemaining === "number" ? r.secondsRemaining : 0;
      if (r.reason === "rate_limited") {
        setError(`Too many attempts. Try again in ${remaining}s.`);
        setSecondsRemaining(remaining);
      } else if (r.reason === "wrong_password") {
        if (remaining > 0) {
          setError(`Wrong password. Locked for ${remaining}s.`);
          setSecondsRemaining(remaining);
        } else {
          setError("Wrong password.");
        }
      } else {
        setError(r.reason ?? "Could not reveal phrase.");
      }
    } catch (e) {
      setError((e as Error).message ?? "Could not reveal phrase.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!mnemonic) return;
    try {
      // Bare words, no ordinals — shared with the onboarding grid via the
      // single `formatPhraseForClipboard` join so the two can't drift.
      // Routed through the shared auto-clear helper so it gets the
      // readText-confirmed wipe AND the flush-on-unmount path (this screen
      // auto-hides after 30 s, which unmounts and would otherwise strand
      // the phrase on the clipboard).
      await copyWithAutoClear(
        formatPhraseForClipboard(mnemonic),
        CLIPBOARD_CLEAR_MS,
      );
      setCopied(true);
      setClearState("idle");
    } catch {
      // Clipboard write can fail in iframes / focus-loss races. Stay quiet.
    }
  };

  const handleClear = async () => {
    const ok = await clearClipboardNow();
    setClearState(ok ? "cleared" : "failed");
    if (ok) setCopied(false);
  };

  // ---- render ----

  if (step === "reauth") {
    const disabled =
      submitting || secondsRemaining > 0 || password.length === 0;
    return (
      <>
        <div className="ext-top">
          <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={15} />
          </button>
          <div
            style={{
              flex: 1,
              fontSize: 14,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            Show recovery phrase
          </div>
          <div style={{ width: 36 }} />
        </div>

        <div style={{ padding: "32px 22px 8px", textAlign: "center" }}>
          <WalletLockLogo size={56} />
          <div
            style={{
              fontSize: 13,
              color: "var(--fg-300)",
              lineHeight: 1.5,
              maxWidth: 280,
              margin: "0 auto",
            }}
          >
            Enter your password to view your 24-word recovery phrase.
          </div>
        </div>

        <div
          style={{
            padding: "16px 18px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <label style={{ display: "block" }}>
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 10,
                color: "var(--fg-400)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Password
            </div>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAuthSubmit();
              }}
              autoFocus
              disabled={secondsRemaining > 0}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 10,
                background: "rgba(0,0,0,0.3)",
                border: "1px solid var(--fg-700)",
                color: "var(--fg-100)",
                fontFamily: "var(--f-mono)",
                fontSize: 13,
                outline: "none",
                boxSizing: "border-box",
                opacity: secondsRemaining > 0 ? 0.5 : 1,
              }}
            />
          </label>

          {error && (
            <div
              style={{
                fontFamily: "var(--f-mono)",
                fontSize: 11,
                color: "var(--err)",
                lineHeight: 1.4,
              }}
            >
              {secondsRemaining > 0
                ? `Too many attempts. Try again in ${secondsRemaining}s.`
                : error}
            </div>
          )}
        </div>

        <div
          className="req-foot"
          style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
        >
          <button
            className="prim"
            disabled={disabled}
            onClick={() => void handleAuthSubmit()}
            style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
          >
            {submitting ? "Checking…" : "Continue"}
          </button>
        </div>
      </>
    );
  }

  if (step === "warning") {
    return (
      <>
        <div className="ext-top">
          <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={15} />
          </button>
          <div
            style={{
              flex: 1,
              fontSize: 14,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            Before you reveal
          </div>
          <div style={{ width: 36 }} />
        </div>

        <div
          style={{
            padding: "20px 18px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <div
            style={{
              padding: "14px 14px",
              borderRadius: 12,
              background: "rgba(242,180,65,0.08)",
              border: "1px solid rgba(242,180,65,0.4)",
              color: "var(--fg-100)",
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Your 24 words are your wallet.
            </div>
            Anyone with these words can steal your funds. Don&apos;t share
            them. Don&apos;t take a screenshot. Don&apos;t enter them into any
            website.
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-400)",
              lineHeight: 1.6,
            }}
          >
            On the next screen, tap the words to reveal them. Tap
            again to hide. The phrase auto-hides after{" "}
            {AUTO_HIDE_SECONDS} seconds. If you copy it, your clipboard
            auto-clears about {AUTO_HIDE_SECONDS} s later while the wallet
            stays open — clear it yourself if you paste it somewhere else.
          </div>
        </div>

        <div
          className="req-foot"
          style={{ marginTop: "auto", gridTemplateColumns: "1fr 1fr" }}
        >
          <button onClick={onBack}>Cancel</button>
          <button
            className="prim"
            onClick={() => {
              setAutoHideRemaining(AUTO_HIDE_SECONDS);
              setStep("reveal");
            }}
          >
            Reveal phrase
          </button>
        </div>
      </>
    );
  }

  // step === "reveal"
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 14, fontWeight: 600, textAlign: "center" }}
        >
          Recovery phrase
        </div>
        <div style={{ width: 36 }} />
      </div>

      {/* Wrap reveal contents in .ext-body so the
         screen scrolls when MnemonicGrid's 15 px-mono words + copy
         button + the auto-hide chip overflow the popup viewport. */}
      <div
        className="ext-body"
        style={{
          // Force the scroll inline too (not just via the .ext-body class):
          // this screen makes .ext-body its own flex column, and a flex item
          // that is also a flex container can otherwise grow past its
          // allocation and clip the 24-word grid instead of scrolling.
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            PQM-1 · 24 words
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--gold)",
              padding: "3px 8px",
              borderRadius: 6,
              background: "var(--gold-bg)",
              border: "1px solid rgba(242,180,65,0.4)",
            }}
          >
            Hides in {autoHideRemaining}s
          </div>
        </div>

        {/* Handwrite-first guidance (primary safe path). The copy button
           below stays available but reads as the secondary convenience. */}
        <div
          style={{
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(242,180,65,0.08)",
            border: "1px solid rgba(242,180,65,0.4)",
            color: "var(--fg-100)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          Write these words down on paper, in order, and keep them offline.
          Don&apos;t screenshot them or save them to a file or the cloud.
        </div>

        {/* Copy button moved ABOVE the reveal-toggle
           wrapper. Previously RevealPhrase rendered TWO copy buttons:
           one inside MnemonicGrid (default-on, embedded under the
           grid words) and one below MnemonicGrid (RevealPhrase's own
           inline `handleCopy`). The MnemonicGrid one was unreachable
           because its container had pointerEvents:none (clicks bubbled
           to the reveal-toggle wrapper, only triggering reveal/hide
           instead of copying) — that was the "broken top copy
           button" the user reported. Hiding it via showCopyButton=false
           and lifting RevealPhrase's own button to the top fixes both
           the duplicate and the position. */}
        <button
          onClick={() => void handleCopy()}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            // Secondary affordance — quiet outline, not a primary action.
            border: "1px solid var(--fg-700)",
            background: "transparent",
            color: copied ? "var(--ok)" : "var(--fg-400)",
            fontFamily: "var(--f-sans)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied
            ? "Copied — auto-clears in ~30 s"
            : "Copy to clipboard"}
        </button>
        <button
          onClick={() => void handleClear()}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid var(--fg-700)",
            background: "transparent",
            color: clearState === "cleared" ? "var(--ok)" : "var(--fg-400)",
            fontFamily: "var(--f-sans)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <Icon
            name={clearState === "cleared" ? "check" : "trash"}
            size={13}
          />
          {clearState === "cleared"
            ? "Clipboard cleared"
            : clearState === "failed"
              ? "Couldn't clear — clear manually"
              : "Clear clipboard"}
        </button>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-500)",
            letterSpacing: "0.04em",
            lineHeight: 1.5,
            textAlign: "center",
          }}
        >
          Only clears while the wallet stays open — clear it yourself if you
          paste it elsewhere.
        </div>

        {/* Tap-to-reveal click target. The grid is blurred (~12 px) by
            default; tapping anywhere on the area toggles `revealed`.
            When revealed, an unintrusive "Tap to hide" hint nudges the
            user toward the close gesture. */}
        {mnemonic && (
          <div
            role="button"
            tabIndex={0}
            aria-pressed={revealed}
            aria-label={
              revealed ? "Hide recovery phrase" : "Reveal recovery phrase"
            }
            onClick={toggleReveal}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleReveal();
              }
            }}
            style={{
              position: "relative",
              borderRadius: 12,
              overflow: "hidden",
              cursor: "pointer",
              userSelect: "none",
              // Don't let this tall, overflow:hidden grid shrink as a flex
              // child of the scrolling .ext-body — otherwise it compresses to a
              // few rows and nothing overflows/scrolls. Keep full height so
              // .ext-body scrolls to reveal all 24 words.
              flexShrink: 0,
            }}
          >
            <div
              style={{
                filter: revealed ? "none" : "blur(12px)",
                transition: "filter 120ms var(--e-out, ease-out)",
                pointerEvents: "none", // clicks pass through to the wrapper
              }}
              aria-hidden={!revealed}
            >
              {/* Disable MnemonicGrid's built-in
                 copy button. It sat inside this pointerEvents:none
                 wrapper so clicks bubbled to toggleReveal() instead
                 of copying — the user reported it as "broken".
                 RevealPhrase's own copy button above is the working
                 one. */}
              <MnemonicGrid mnemonic={mnemonic} showCopyButton={false} />
            </div>
            {!revealed && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  background: "rgba(0,0,0,0.4)",
                  borderRadius: 12,
                  textAlign: "center",
                  padding: 12,
                  pointerEvents: "none",
                }}
              >
                <Icon name="eye" size={20} />
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--fg-100)",
                  }}
                >
                  Tap to reveal
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--fg-300)",
                    lineHeight: 1.4,
                  }}
                >
                  Make sure no one is watching your screen.
                </div>
              </div>
            )}
          </div>
        )}

        {revealed && (
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-500)",
              letterSpacing: "0.08em",
              textAlign: "center",
            }}
          >
            Tap the words to hide them.
          </div>
        )}
      </div>

      <div
        className="req-foot"
        style={{ marginTop: "auto", gridTemplateColumns: "1fr" }}
      >
        <button className="prim" onClick={onBack}>
          Done
        </button>
      </div>
    </>
  );
}
