import { WalletLogo } from "../components/WalletLogo";
import { PreferencesPanel } from "../components/PreferencesPanel";

interface WelcomeProps {
  onCreateNew: () => void;
  onImport: () => void;
  /** Routes to the ForgotPassword info page. Optional so the welcome
   *  screen still renders cleanly in contexts that don't yet wire the
   *  forgotten-password recovery flow. */
  onForgotPassword?: () => void;
}

export function Welcome({
  onCreateNew,
  onImport,
  onForgotPassword,
}: WelcomeProps) {
  return (
    <>
      {/* Intro + first-run display preferences scroll together; the action
         buttons stay pinned as a footer. The preferences (theme / language /
         display-currency) are collapsible — tap a row to choose, it collapses
         again — and apply immediately. They never block onboarding: Create /
         Import go straight to their forms. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div
          style={{
            padding: "36px 22px 8px",
            textAlign: "center",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "center" }}>
            <WalletLogo size={72} />
          </div>
          <h1
            style={{
              margin: "8px 0 0",
              fontSize: "var(--fs-20)",
              fontWeight: 600,
              color: "var(--fg-100)",
            }}
          >
            Welcome to Monolythium
          </h1>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 10,
              color: "var(--fg-400)",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            Sovereign post-quantum wallet
          </div>
          <p
            style={{
              margin: "10px 16px 0",
              fontSize: "var(--fs-12)",
              color: "var(--fg-300)",
              lineHeight: 1.5,
            }}
          >
            ML-DSA-65 keys, signed in your browser. Your phrase never
            leaves this device.
          </p>
        </div>

        <div style={{ padding: "12px 18px 4px" }}>
          <PreferencesPanel includeTheme={true} />
        </div>
      </div>

      <div
        style={{
          padding: "8px 18px 24px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <button
          className="prim"
          onClick={onCreateNew}
          style={{
            padding: "13px 16px",
            borderRadius: 10,
            border: "1px solid var(--gold)",
            background:
              "linear-gradient(180deg, var(--gold-hi), var(--gold))",
            color: "var(--ink-000)",
            fontFamily: "var(--f-sans)",
            fontWeight: 600,
            fontSize: "var(--fs-13)",
            cursor: "pointer",
            boxShadow:
              "0 4px 14px rgba(var(--gold-glow), 0.3), inset 0 1px 0 rgba(255,255,255,0.35)",
          }}
        >
          Create new wallet
        </button>
        <button
          onClick={onImport}
          style={{
            padding: "13px 16px",
            borderRadius: 10,
            border: "1px solid var(--fg-700)",
            background: "rgba(255,255,255,0.05)",
            color: "var(--fg-100)",
            fontFamily: "var(--f-sans)",
            fontWeight: 500,
            fontSize: "var(--fs-13)",
            cursor: "pointer",
          }}
        >
          Import existing wallet
        </button>
        {onForgotPassword && (
          <button
            onClick={onForgotPassword}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--fg-400)",
              fontFamily: "var(--f-sans)",
              fontWeight: 500,
              fontSize: 11.5,
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            Forgot password?
          </button>
        )}
      </div>
    </>
  );
}
