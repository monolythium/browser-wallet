// Help page — copy and structure guards.
//
// This page's entire value is that every claim on it was traced to code. These
// tests pin the sentences whose loss would put a FALSE safety guarantee back in
// front of a user, and pin the derived values so the page cannot drift from the
// constants it reads.
//
// What this file CANNOT see: whether the copy is true (no test can), the expand
// interaction (renderToStaticMarkup runs no effects or events), layout, focus
// order and pointer behaviour.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MLDSA65_MNEMONIC_WORDS } from "@monolythium/core-sdk/crypto";

import { Help, type HelpEntryKey } from "./Help.js";
import {
  chainHealthPresentation,
  HEALTH_TICK_MS,
  STALL_THRESHOLD_MS,
} from "../components";
import { WIPE_CONFIRM_WORD } from "../../shared/constants";
import { EXTERNAL_LINKS } from "../../shared/build-info";
import { useFeature } from "../hooks/useFeature";

// Developer mode is OFF for every test unless a test turns it on. That matches
// the shipped default and keeps the copy assertions below measuring the page a
// normal user sees.
vi.mock("../hooks/useFeature", () => ({ useFeature: vi.fn(() => false) }));

beforeEach(() => {
  vi.mocked(useFeature).mockImplementation(() => false);
});

/** Render with developer mode on. */
const withDevMode = (fn: () => string): string => {
  vi.mocked(useFeature).mockImplementation((flag: string) => flag === "DEVELOPER_MODE");
  try {
    return fn();
  } finally {
    vi.mocked(useFeature).mockImplementation(() => false);
  }
};

/** The page as it first renders — every entry collapsed. */
const html = () => renderToStaticMarkup(<Help onBack={() => undefined} />);

/** One entry rendered open. `Section` renders children only while open, so a
 *  collapsed page contains none of the copy below; the guards would pass
 *  vacuously against `html()`. */
const openEntry = (key: HelpEntryKey) =>
  renderToStaticMarkup(<Help onBack={() => undefined} initialOpen={key} />);

/** Every entry's copy concatenated, for guards that must hold page-wide. */
const ALL_ENTRIES: HelpEntryKey[] = [
  "chip",
  "phrase",
  "lost",
  "restore",
  "reset",
  "fee",
  "cap",
  "more",
];
const wholePage = () => ALL_ENTRIES.map(openEntry).join("\n");

/** Sentences from the ORIGINAL draft that the fact-check proved false. Kept
 *  here as fixtures so the negative guards below are shown to actually match a
 *  regression — a `not.toMatch` that matches nothing would pass vacuously. */
const REFUTED_DRAFT_CLAIMS = {
  resetNeedsPhrase:
    "To confirm, you must enter this wallet's 24-word recovery phrase — proof that you can restore it afterward.",
  switchOperators:
    "The app reconnects once it matches again, or switch to another operator on your wallet's network.",
};

describe("Help — structure", () => {
  it("renders every entry collapsed", () => {
    expect(html()).toContain('aria-expanded="false"');
  });

  it("renders no expanded entry before interaction", () => {
    expect(html()).not.toContain('aria-expanded="true"');
  });
});

describe("Help — derived values (never typed)", () => {
  it("renders the word count from MLDSA65_MNEMONIC_WORDS", () => {
    expect(openEntry("phrase")).toContain(`${MLDSA65_MNEMONIC_WORDS} words`);
    expect(openEntry("restore")).toContain(`${MLDSA65_MNEMONIC_WORDS}-word`);
  });

  it("renders the reset word from WIPE_CONFIRM_WORD", () => {
    expect(openEntry("reset")).toContain(WIPE_CONFIRM_WORD);
  });

  it("renders chip labels from chainHealthPresentation", () => {
    const page = openEntry("chip");
    for (const kind of [
      "live",
      "stalled",
      "offline",
      "quarantined",
      "untrusted",
      "regenesis",
      "loading",
      "reconnecting",
    ] as const) {
      expect(page).toContain(chainHealthPresentation(kind).label);
    }
  });

  it("renders link URLs from EXTERNAL_LINKS", () => {
    const page = openEntry("more");
    for (const label of ["GitHub", "Telegram", "Discord"]) {
      const entry = EXTERNAL_LINKS.find((l) => l.label === label);
      expect(entry, `${label} missing from EXTERNAL_LINKS`).toBeDefined();
      expect(page).toContain(entry!.url);
    }
  });
});

describe("Help — load-bearing safety copy", () => {
  it("states that nothing checks for the recovery phrase before a reset", () => {
    expect(openEntry("reset")).toMatch(
      /nothing checks whether you actually have your recovery phrase/i,
    );
  });

  it("states that both reset paths complete without the phrase", () => {
    expect(openEntry("reset")).toMatch(/both reset paths complete without it/i);
  });

  it("states that degraded states do not stop you sending", () => {
    expect(openEntry("chip")).toMatch(/they do not stop you from sending/i);
  });

  // Inline <strong> markup sits between these phrases, so the gap matcher must
  // allow tags. Both phrases are still required, in order and close together.
  it("states that Forgot password erases rather than recovers", () => {
    expect(openEntry("lost")).toMatch(
      /forgot password[\s\S]{0,60}doesn&#x27;t recover anything/i,
    );
  });

  it("carries the closing anti-phishing warning", () => {
    expect(openEntry("more")).toMatch(
      /will ever ask for your recovery phrase[\s\S]{0,20}password/i,
    );
  });
});

describe("Help — deep link from the degraded-network banner", () => {
  const withFocus = (kind: Parameters<typeof chainHealthPresentation>[0]) =>
    renderToStaticMarkup(<Help onBack={() => undefined} focusState={kind} />);

  it("opens Connection status and marks the requested entry", () => {
    const page = withFocus("offline");
    expect(page).toContain('aria-expanded="true"');
    expect(page).toContain('data-focus-state="offline"');
    expect(page).toContain(chainHealthPresentation("offline").label);
  });

  it("marks only the requested entry", () => {
    const page = withFocus("stalled");
    expect(page).toContain('data-focus-state="stalled"');
    expect(page).not.toContain('data-focus-state="offline"');
  });

  // The regression that matters most: the menu entry passes no target, so Help
  // must still open completely collapsed for an ordinary visit.
  it("entering Help without a target still opens everything collapsed", () => {
    const page = html();
    expect(page).not.toContain('aria-expanded="true"');
    expect(page).not.toContain("data-focus-state");
  });
});

describe("Help — developer-mode mechanics", () => {
  it("shows no mechanics when developer mode is off", () => {
    const page = openEntry("chip");
    expect(page).not.toContain("Polls every");
    expect(page).not.toContain("DEV");
  });

  it("shows the mechanics when developer mode is on", () => {
    const page = withDevMode(() => openEntry("chip"));
    expect(page).toContain("Polls every");
    // The DEV marker, per the wallet-wide convention.
    expect(page).toContain("DEV");
  });

  // The whole point of these blocks is that the numbers are DERIVED. Asserting
  // against the constants means a change to either constant moves the page and
  // this test together — a literal here would let them drift apart silently.
  it("renders the poll cadence and stall threshold from their constants", () => {
    const page = withDevMode(() => openEntry("chip"));
    expect(page).toContain(`${HEALTH_TICK_MS / 1000} seconds`);
    expect(page).toContain(`${STALL_THRESHOLD_MS / 1000} seconds`);
  });

  it("does not render the operator-name poll beside a health mechanic", () => {
    // OPERATOR_TICK_MS (10s) drives the operator-NAME poll, not health. A
    // plausible-looking wrong number next to a health mechanic is worse than
    // an absent one, so 10 seconds must not appear here.
    expect(withDevMode(() => openEntry("chip"))).not.toContain("10 seconds");
  });
});

describe("Help — refuted claims must not return", () => {
  // Each guard is first shown to MATCH the draft sentence it exists to catch,
  // so a passing `not.toMatch` below is evidence, not a tautology.
  const resetGuard = /recovery phrase[^.]{0,40}proof that you can restore/i;
  const operatorGuard = /switch to another operator/i;

  it("the reset guard would catch the draft's refuted wording", () => {
    expect(REFUTED_DRAFT_CLAIMS.resetNeedsPhrase).toMatch(resetGuard);
  });

  it("never claims the reset requires the recovery phrase", () => {
    expect(wholePage()).not.toMatch(resetGuard);
  });

  it("the operator guard would catch the draft's refuted wording", () => {
    expect(REFUTED_DRAFT_CLAIMS.switchOperators).toMatch(operatorGuard);
  });

  it("offers no operator-switching remedy", () => {
    expect(wholePage()).not.toMatch(operatorGuard);
  });
});
