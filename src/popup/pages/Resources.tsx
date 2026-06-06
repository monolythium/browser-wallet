// Resources — standalone surface for the external links (docs, explorer,
// repo, etc.), reached from the hamburger "Resources" entry. Mirrors the
// About page's Resources card (same EXTERNAL_LINKS source of truth).

import { Icon } from "../Icon";
import { EXTERNAL_LINKS } from "../../shared/build-info";
import { useFeature } from "../hooks/useFeature";

interface ResourcesProps {
  onBack: () => void;
}

export function Resources({ onBack }: ResourcesProps) {
  const devMode = useFeature("DEVELOPER_MODE");
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Resources
        </div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body">
        <div className="ext-card">
          <div className="ext-card__head">
            <h3>Resources</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {EXTERNAL_LINKS.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid var(--fg-700)",
                  background: "rgba(255,255,255,0.04)",
                  color: "var(--fg-100)",
                  fontSize: 12.5,
                  textDecoration: "none",
                }}
              >
                <span>{link.label}</span>
                {devMode && (
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 10,
                      color: "var(--fg-500)",
                      maxWidth: 180,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {link.url.replace(/^https?:\/\//, "")}
                  </span>
                )}
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
