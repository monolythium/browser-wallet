// ErrorBoundary.
//
// React component-tree error boundary. A render-time throw inside any
// page would otherwise unmount the whole popup with a blank screen;
// this catches and renders a friendly fallback with a diagnostic copy
// button so users can report it.
//
// Scope: wraps the App's top-level page render. Per-page wrappers
// could land later if a specific surface needs different recovery
// copy, but a single root boundary catches every page-level throw
// uniformly today.

import { Component } from "react";
import type { CSSProperties, ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback override. Defaults to the built-in card. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // SW dev-tools console + future telemetry hook. The wallet doesn't
    // ship a telemetry pipeline today; a future "report issue" feature
    // could read from here.
    console.error("[wallet] uncaught render error:", error, info);
  }

  reset = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return <DefaultFallback error={error} onReset={this.reset} />;
  }
}

function DefaultFallback({
  error,
  onReset,
}: {
  error: Error;
  onReset: () => void;
}) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(
        `Monolythium Wallet error\n\n${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`,
      );
    } catch {
      // clipboard may be unavailable; user can still screenshot
    }
  };
  return (
    <div style={cardStyle} role="alert">
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "var(--err)",
          marginBottom: 8,
        }}
      >
        Something went wrong
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-300)",
          lineHeight: 1.5,
          marginBottom: 10,
        }}
      >
        The wallet caught an unexpected error. Your funds and recovery
        phrase are safe — only the current screen was affected. Try
        again, or reload the popup.
      </div>
      <details
        style={{
          marginBottom: 12,
          fontSize: 10,
          color: "var(--fg-400)",
          fontFamily: "var(--f-mono)",
        }}
      >
        <summary style={{ cursor: "pointer", marginBottom: 6 }}>
          Technical details
        </summary>
        <div
          style={{
            padding: 8,
            borderRadius: 6,
            background: "rgba(0,0,0,0.25)",
            border: "1px solid var(--fg-700)",
            wordBreak: "break-word",
            whiteSpace: "pre-wrap",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {error.name}: {error.message}
          {"\n\n"}
          {error.stack ?? "(no stack)"}
        </div>
      </details>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={onReset} style={primaryBtn}>
          Try again
        </button>
        <button type="button" onClick={handleCopy} style={ghostBtn}>
          Copy details
        </button>
      </div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  margin: 16,
  padding: 16,
  borderRadius: 12,
  background: "rgba(220,80,80,0.06)",
  border: "1px solid rgba(220,80,80,0.4)",
};

const primaryBtn: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  fontSize: 12,
  fontFamily: "var(--f-sans)",
  fontWeight: 600,
  color: "var(--gold)",
  background: "var(--gold-bg)",
  border: "1px solid var(--gold)",
  borderRadius: 6,
  cursor: "pointer",
};

const ghostBtn: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  fontSize: 12,
  fontFamily: "var(--f-sans)",
  color: "var(--fg-300)",
  background: "rgba(255,255,255,0.04)",
  border: "1px solid var(--fg-700)",
  borderRadius: 6,
  cursor: "pointer",
};
