import { createRoot } from "react-dom/client";
import App from "./App";

// Round 4 TASK 4 — runtime mode discriminator. Chrome popups have
// fixed dimensions matching the body width/height we declare; the
// side-panel viewport is whatever Chrome's panel chrome assigns
// (typically ~360-500 wide, full vertical height of the browser
// window). We sample the viewport once at boot and stamp <html
// data-mode="…"> so CSS can branch:
//   html[data-mode="popup"]     → fixed 380×620 frame
//   html[data-mode="sidepanel"] → 100% width / 100vh
// A small hysteresis on width keeps the popup case stable even when
// the user resizes a side-panel slightly below 460 px.
function detectMode(): "popup" | "sidepanel" {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (h > 700 || w > 460) return "sidepanel";
  return "popup";
}
document.documentElement.dataset.mode = detectMode();

createRoot(document.getElementById("root")!).render(<App />);
