// "About Monolythium" page — the §28.5 differentiation pitch, reached from the
// hamburger "Why Monolythium" entry. Reuses WALLET_PITCH (the same source as
// the About page's "Why Monolythium" card), so the two stay in lock-step.

import { Icon } from "../Icon";
import { WALLET_PITCH } from "../../shared/build-info";

interface WhyMonolythiumProps {
  onBack: () => void;
}

export function WhyMonolythium({ onBack }: WhyMonolythiumProps) {
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
        >
          About Monolythium
        </div>
        <div style={{ width: 36 }} />
      </div>
      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Why Monolythium</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {WALLET_PITCH.map((p) => (
              <div key={p.title}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--fg-100)",
                    marginBottom: 3,
                  }}
                >
                  {p.title}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--fg-300)",
                    lineHeight: 1.5,
                  }}
                >
                  {p.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
