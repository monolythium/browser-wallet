import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readTheme } from "./theme";

// Runtime mode discriminator. The earlier viewport heuristic
// (h > 700 || w > 460) failed on shorter browser windows: a 720-pixel
// browser opens the side panel at ~700 px tall, falling under the
// height threshold AND under the width threshold, so detection
// returned "popup" and CSS pinned the wallet to a 380 px column with
// black space filling the remainder of the panel.
//
// The authoritative signal is the URL: manifest.json gives the side
// panel a `?surface=sidepanel` query so any code loading that path
// knows for certain it's rendering inside the panel. The action
// popup loads the bare path without the query. Viewport heuristics
// remain as a defensive fallback (e.g. dev-reload scenarios where the
// query string is stripped manually).
//
// CSS branches on the stamped attribute:
//   html[data-mode="popup"]     → fixed 380×620 frame
//   html[data-mode="sidepanel"] → 100% width / 100vh, fills the panel
// Adds "fullscreen" as a third surface. Opened via
// chrome.tabs.create with ?mode=fullscreen so the same React app
// runs in a regular Chrome tab. CSS branches on data-mode the same
// way as popup / sidepanel.
function detectMode(): "popup" | "sidepanel" | "fullscreen" {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("mode") === "fullscreen") return "fullscreen";
    if (params.get("surface") === "sidepanel") return "sidepanel";
    if (params.get("surface") === "popup") return "popup";
  } catch {
    // URLSearchParams should never throw, but be defensive against
    // future URL handling edge cases — fall back to the viewport
    // heuristic below.
  }
  // Fallback: anything taller than the popup's 620 px ceiling is the
  // side panel. Tighter than the earlier threshold so shorter
  // browsers (~720 px tall) still get the right mode.
  if (window.innerHeight > 640) return "sidepanel";
  return "popup";
}
document.documentElement.dataset.mode = detectMode();

// Apply the saved theme before first paint (localStorage is synchronous, so
// there is no flash of the default palette on popup open).
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(<App />);
