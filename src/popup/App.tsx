// Liquid-glass charcoal placeholder. Real design port lands in a later stage.
const popupStyle: React.CSSProperties = {
  minWidth: 360,
  minHeight: 480,
  margin: 0,
  padding: "32px 24px",
  background:
    "radial-gradient(120% 80% at 0% 0%, rgba(216, 80, 218, 0.18) 0%, rgba(11, 11, 14, 0) 55%)," +
    "radial-gradient(120% 80% at 100% 100%, rgba(120, 60, 220, 0.18) 0%, rgba(11, 11, 14, 0) 55%)," +
    "#0b0b0e",
  color: "#f5f5f7",
  fontFamily:
    "'IBM Plex Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 24,
};

const headingStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: "0.01em",
  margin: 0,
  color: "#f5f5f7",
};

const subStyle: React.CSSProperties = {
  fontSize: 12,
  color: "rgba(245, 245, 247, 0.6)",
  margin: 0,
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
};

const buttonStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid rgba(242, 180, 65, 0.3)",
  background: "linear-gradient(180deg, #f2b441 0%, #d99a2a 100%)",
  color: "#0b0b0e",
  fontWeight: 600,
  fontSize: 13,
  letterSpacing: "0.02em",
  cursor: "pointer",
  fontFamily: "inherit",
};

export default function App(): React.ReactElement {
  return (
    <div style={popupStyle}>
      <div>
        <h1 style={headingStyle}>Monolythium Wallet</h1>
        <p style={subStyle}>scaffold v0.0.1</p>
      </div>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => console.log("Monolythium Wallet: placeholder action")}
      >
        Connect (placeholder)
      </button>
    </div>
  );
}
