// Help — question-and-answer entries under the Info menu category.
//
// Every factual claim on this page was traced to code before it was written
// (see _dev-notes 2026-08-01_help-page-plan.md). Two rules this file must keep:
//
//   1. No number or URL that exists as a constant is typed. The word count comes
//      from MLDSA65_MNEMONIC_WORDS, the reset word from WIPE_CONFIRM_WORD, the
//      chip labels from chainHealthPresentation -- the same function the chip
//      itself renders from, so this page cannot drift from it -- and every link
//      from EXTERNAL_LINKS. The operator remedy is derived from the registry
//      count, because "there is nothing to switch to" stops being true the day
//      the registry publishes a second endpoint, with no wallet edit involved.
//
//   2. No remedy is offered that the shipped build cannot perform. Operator
//      management is developer-gated (pages/Operators) and the registry fleet is
//      a single host, so "switch operators" is offered nowhere below -- even
//      though the chip's own tooltip still says it.
//
// This page DESCRIBES behaviour. It must never gate, pause or alter anything.

import { useState } from "react";
import type { ReactNode } from "react";
import { getRpcEndpoints } from "@monolythium/core-sdk";
import { MLDSA65_MNEMONIC_WORDS } from "@monolythium/core-sdk/crypto";

import { Icon, type IconName } from "../Icon";
import { Section } from "../components/Section";
import { ExternalLink } from "../components/ExternalLink";
import { chainHealthPresentation, type ChainHealthKind } from "../components";
import {
  CHAIN_STATE_COPY,
  CHAIN_STATE_ORDER,
} from "../chain-health-copy";
import { WIPE_CONFIRM_WORD } from "../../shared/constants";
import { EXTERNAL_LINKS } from "../../shared/build-info";

/** Heading for a state's entry: the chip's OWN label, read from the same helper
 *  the chip renders from, so a relabelled state can never leave this page
 *  describing the old one. `reconnecting` keeps the block-number prefix the
 *  chip shows alongside it (`reconnectingBannerLabel` renders
 *  "LAST SEEN #<n> · <label>"); the number is per-session, so the documentation
 *  shows its shape rather than a fabricated height. */
function stateHeading(kind: ChainHealthKind): string {
  const label = chainHealthPresentation(kind).label;
  return kind === "reconnecting" ? `LAST SEEN #… · ${label}` : label;
}

/** Links surfaced here, resolved out of EXTERNAL_LINKS by label so no URL is
 *  ever retyped. A label that stops existing simply drops out rather than
 *  rendering a broken link. */
const HELP_LINK_LABELS = [
  "Monolythium",
  "Documentation",
  "GitHub",
  "Telegram",
  "Discord",
];
const helpLinks = HELP_LINK_LABELS.map((label) =>
  EXTERNAL_LINKS.find((link) => link.label === label),
).filter((link): link is (typeof EXTERNAL_LINKS)[number] => link !== undefined);

/** The address as a reader would say it: no scheme, no `www.`, no trailing
 *  slash. Applied uniformly to every row so no URL is ever hand-written here —
 *  the stored value in EXTERNAL_LINKS stays the single source of truth, and
 *  what the link NAVIGATES to is always the untouched `link.url`. Only the
 *  display text is shortened, and never mid-path: a truncated address on a
 *  wallet help page is worse than a wrapped one. */
function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

/** Whether the pinned registry publishes exactly one RPC endpoint. Derived from
 *  the same SDK registry `networks.ts` maps into the operator defaults (and that
 *  `testnet-fallback` already reads popup-side), NOT from a background module.
 *  Gates one clause of the connection-status remedy: with a single operator
 *  there is genuinely nothing to switch to, and saying so is only honest for as
 *  long as that stays true. */
const SINGLE_OPERATOR = getRpcEndpoints("testnet-69420").length === 1;

/** Keys of the collapsible entries, in render order. */
export type HelpEntryKey =
  | "chip"
  | "phrase"
  | "lost"
  | "restore"
  | "reset"
  | "fee"
  | "cap"
  | "more";

interface HelpProps {
  onBack: () => void;
  /** Entry to open on mount; every entry is closed when omitted. `Section`
   *  renders its children only while open, so this is also what lets the copy
   *  guards in Help.test observe real markup rather than a detached constant. */
  initialOpen?: HelpEntryKey;
}

/** Muted category label above a group of entries. Mirrors the uppercase mono
 *  idiom already used for sub-headings elsewhere in the popup.
 *
 *  Deliberately held BELOW the accordion question titles (`sectionBtn`: 13px
 *  sans / weight 500 / --fg-100), which are the page's primary tap targets: this
 *  stays 11px mono uppercase at --fg-300, so it reads as a category marker
 *  rather than competing with the questions beneath it. */
function GroupLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 11,
        color: "var(--fg-300)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        margin: "16px 2px 8px",
      }}
    >
      {children}
    </div>
  );
}

/** A named connection state: the chip's own label, then what it means.
 *
 *  `divider` draws the hairline ABOVE this entry, so the caller passes it for
 *  every entry after the first — that keeps the rules strictly BETWEEN entries,
 *  with none above the first or below the last. */
function StateEntry({
  label,
  divider,
  children,
}: {
  label: string;
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={
        divider === true
          ? {
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid var(--fg-700)",
            }
          : { marginTop: 0 }
      }
    >
      <div
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--fg-100)",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  );
}

const bodyText = {
  fontSize: 11.5,
  color: "var(--fg-300)",
  lineHeight: 1.6,
  marginBottom: 10,
} as const;

export function Help({ onBack, initialOpen }: HelpProps) {
  // Single-open accordion: opening one entry closes the previous.
  const [open, setOpen] = useState<string | null>(initialOpen ?? null);
  const toggle = (key: string) => setOpen((p) => (p === key ? null : key));
  const sectionProps = (key: string) => ({
    open: open === key,
    onToggle: () => toggle(key),
  });

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 15, fontWeight: 600, textAlign: "center" }}
        >
          Help
        </div>
        <div style={{ width: 36 }} />
      </div>

      <div className="ext-body">
        <div style={{ ...bodyText, color: "var(--fg-400)", marginBottom: 4 }}>
          Short answers about how this wallet works. Tap a question to open it.
        </div>

        <GroupLabel>Connection status</GroupLabel>

        <Section
          title="What does the connection chip mean?"
          {...sectionProps("chip")}
        >
          <div style={bodyText}>
            The chip at the top of the wallet shows whether it can reach the
            network.
          </div>

          {/* One entry per state, rendered from the shared copy source so the
             chip label, this answer and the banner's short line can never
             drift apart. The divider keys off the index — rules strictly
             BETWEEN entries, none above the first. */}
          {CHAIN_STATE_ORDER.map((kind, i) => (
            <StateEntry
              key={kind}
              divider={i > 0}
              label={stateHeading(kind)}
            >
              {CHAIN_STATE_COPY[kind].long}
            </StateEntry>
          ))}

          {/* The ninth and LAST ruled entry — carries a rule above it like the
             others, and none below, so the sequence closes cleanly before the
             section's own boundary. */}
          <StateEntry divider label="What you can do">
            For any of these, tapping the chip opens the operator list, where{" "}
            <strong>Use this operator</strong> forces a fresh connection attempt.
            {SINGLE_OPERATOR
              ? " Beyond that, waiting is the remedy — this wallet ships with a single operator, so there is nothing to switch to."
              : " Beyond that, waiting is the remedy."}
          </StateEntry>

          <div style={{ ...bodyText, color: "var(--fg-200)", marginTop: 12 }}>
            <strong>
              These states hide your balance; they do not stop you from sending.
            </strong>{" "}
            The wallet still lets you sign and submit a transaction while the
            network is degraded, and it may not go through.
          </div>
        </Section>

        <GroupLabel>Recovery phrase &amp; backups</GroupLabel>

        <Section
          title="What is a recovery phrase, and how do I keep it safe?"
          {...sectionProps("phrase")}
        >
          <div style={bodyText}>
            Your recovery phrase is the {MLDSA65_MNEMONIC_WORDS} words this
            wallet generated when you created it. Together they{" "}
            <em>are</em> your wallet: anyone who has them can move your funds,
            and they&apos;re the only way to restore it on another device.
          </div>
          <div style={bodyText}>
            Write them on paper and keep them somewhere private and offline.
            Don&apos;t screenshot them, and don&apos;t put them in cloud notes,
            photos, or a password manager that syncs — a copy you can&apos;t
            delete can be stolen. Never type them into a website.
          </div>
          <div style={{ ...bodyText, color: "var(--fg-200)" }}>
            No one from Monolythium — no support agent, no
            &ldquo;foundation&rdquo; — will ever ask for them. Anyone who does is
            trying to steal your funds.
          </div>
        </Section>

        <Section
          title="What if I lose my recovery phrase?"
          {...sectionProps("lost")}
        >
          <div style={bodyText}>
            No one, including Monolythium, can recover a lost phrase — the
            wallet is non-custodial and holds nothing on your behalf.
            There&apos;s no password reset and no backdoor.
          </div>
          <div style={{ ...bodyText, color: "var(--fg-200)" }}>
            The <strong>Forgot password</strong> option doesn&apos;t recover
            anything: it erases the wallet from this browser so you can restore
            it from your phrase. Without the phrase, using it makes your funds
            permanently unreachable.
          </div>
        </Section>

        <GroupLabel>Resetting &amp; restoring</GroupLabel>

        <Section
          title="How do I restore my wallet on a new device?"
          {...sectionProps("restore")}
        >
          <div style={bodyText}>
            Install the wallet, choose <strong>Import existing wallet</strong>,
            and enter your {MLDSA65_MNEMONIC_WORDS}-word phrase. Entering the
            same phrase into this wallet always produces the same address, so
            your balance shows again once the wallet can reach the network.
          </div>
        </Section>

        <Section
          title="How do I reset the wallet, and what does it erase?"
          {...sectionProps("reset")}
        >
          <div style={bodyText}>
            <strong>Settings → Reset wallet</strong> permanently deletes this
            wallet from this browser. It asks for your <strong>password</strong>{" "}
            and for you to type <strong>{WIPE_CONFIRM_WORD}</strong>. This
            can&apos;t be undone from the app.
          </div>
          <div style={{ ...bodyText, color: "var(--fg-200)" }}>
            <strong>
              Nothing checks whether you actually have your recovery phrase.
            </strong>{" "}
            Both reset paths complete without it — the one reached from the
            unlock screen asks only for the typed word. If you reset without your
            phrase, your funds are unreachable forever. Confirm you have it, on
            paper, before you start.
          </div>
        </Section>

        <GroupLabel>Fees &amp; delegation</GroupLabel>

        <Section
          title="Why is the network fee paid in LYTH?"
          {...sectionProps("fee")}
        >
          <div style={bodyText}>
            Every transaction pays its fee in the chain&apos;s native token,
            LYTH, even when you&apos;re sending something else. The wallet checks
            before signing and stops you if your balance is too low. If it
            hasn&apos;t finished loading your balance, it lets you continue and
            the network rejects the transaction instead.
          </div>
          <div style={bodyText}>
            The <strong>Estimated fee</strong> shown on the Send screen is what
            the network is expected to actually deduct. You need a little more
            than that in your balance: the network checks against a higher limit
            when it accepts the transaction, and refunds the unused part.
          </div>
        </Section>

        <Section
          title="How much can I delegate to one cluster?"
          {...sectionProps("cap")}
        >
          <div style={bodyText}>
            The network limits how much of your delegation can go to any one
            cluster,
            so no single cluster gains too much influence. The delegate screen
            shows the current limit when it can read it from the network. Your
            total delegation across all clusters can&apos;t exceed 100%.
          </div>
          <div style={bodyText}>
            If a delegation would cross the limit, reduce the amount or spread it
            across more clusters.
          </div>
        </Section>

        <GroupLabel>Get more help</GroupLabel>

        <Section title="Where can I get more help?" {...sectionProps("more")}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginBottom: 10,
            }}
          >
            {helpLinks.map((link) => (
              <ExternalLink key={link.url} href={link.url}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    minWidth: 0,
                  }}
                >
                  <Icon name={link.icon as IconName} size={13} />
                  <span>{link.label}</span>
                  <span
                    style={{
                      fontFamily: "var(--f-mono)",
                      fontSize: 10.5,
                      color: "var(--fg-400)",
                      wordBreak: "break-all",
                    }}
                  >
                    {displayUrl(link.url)}
                  </span>
                </span>
              </ExternalLink>
            ))}
          </div>
          <div style={bodyText}>
            Telegram and Discord are community channels — other users, not a
            support desk. Nobody is on duty, and there&apos;s no ticket queue or
            response guarantee.
          </div>
          <div style={{ ...bodyText, color: "var(--fg-200)" }}>
            <strong>
              No one from Monolythium, and no one in any community channel, will
              ever ask for your recovery phrase or your password. Anyone who does
              is trying to steal your funds.
            </strong>
          </div>
        </Section>
      </div>
    </>
  );
}
