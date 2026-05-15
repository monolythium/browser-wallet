// Phase 6 — phishing heuristics for approval screens.
//
// Two pure surfaces:
//   - detectOriginWarnings: applied to dApp `origin` strings on connect /
//     send / sign approval screens. Catches the common patterns (plain
//     HTTP, IDN/punycode, mixed-script homographs against well-known
//     brands, suspicious TLDs paired with brand-name lookalikes).
//   - detectMessageWarnings: applied to personal_sign payloads. Catches
//     ABI-shaped hex (an attacker forwarding a tx as a "signature"),
//     EIP-2612 Permit / Permit2 templates (the canonical address-
//     grabber), pure-binary payloads, and oversized blobs.
//
// Both functions return an array of warnings (possibly empty). The UI
// renders them as non-blocking banners — the user can still proceed, but
// loud and explicit, per the §28.5 "wallet must surface origin clearly"
// requirement.
//
// The heuristic set is intentionally conservative. False positives on
// the connect path damage the wallet's trust more than a missed warning
// on a sign path, so the rules trigger only on clear shape matches.

export type WarningLevel = "warning" | "danger";

export interface OriginWarning {
  level: WarningLevel;
  /** Stable code for tests and analytics. */
  code: string;
  /** User-facing copy, one short sentence. */
  text: string;
}

export interface MessageWarning {
  level: WarningLevel;
  code: string;
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Origin heuristics
// ─────────────────────────────────────────────────────────────────────────────

/** TLDs that have a documented history of phishing density. We don't block
 *  the connection — we just flag when paired with a brand-name lookalike. */
const RISKY_TLDS = new Set([
  "tk",
  "ml",
  "ga",
  "cf",
  "gq",
  "top",
  "xyz",
  "click",
  "click",
  "support",
  "cam",
  "rest",
  "country",
]);

/** Well-known crypto brand-name fragments. A hostname containing one of
 *  these as a substring (rather than the canonical second-level domain)
 *  is a strong phishing signal. The list is short on purpose — false
 *  positives here are worse than misses. */
const BRAND_FRAGMENTS = [
  "monolyth",
  "monoscan",
  "metamask",
  "coinbase",
  "uniswap",
  "opensea",
  "ledger",
  "trezor",
  "phantom",
  "ethereum",
] as const;

/** Canonical brand domains. A hostname that ends with one of these is
 *  legitimate (or at least a subdomain of the canonical brand) and does
 *  NOT trigger the brand-lookalike rule. */
const CANONICAL_BRAND_HOSTS = [
  "monolythium.org",
  "monolythium.vision",
  "monoscan.io",
  "metamask.io",
  "coinbase.com",
  "uniswap.org",
  "opensea.io",
  "ledger.com",
  "trezor.io",
  "phantom.app",
  "ethereum.org",
] as const;

/** Cyrillic/Greek characters that visually overlap Latin letters. Tight
 *  set chosen so we don't false-flag genuinely non-Latin-script domains
 *  (Russian-language dApps on .рф, Greek-language dApps on .gr). */
const HOMOGRAPH_RE = /[аеорсхуαερορсхуνмМ]/;

/** Pull the hostname substring out of the raw origin without going
 *  through URL parsing — URL.hostname IDN-to-ASCIIs any non-ASCII chars,
 *  which kills the homograph check. */
function extractRawHostname(origin: string): string {
  // Trim leading `<scheme>://` if present.
  const schemeEnd = origin.indexOf("://");
  const afterScheme = schemeEnd >= 0 ? origin.slice(schemeEnd + 3) : origin;
  // Cut at first `/`, `?`, `#`, or `:` (port separator).
  const cut = afterScheme.search(/[/?#:]/);
  return cut >= 0 ? afterScheme.slice(0, cut) : afterScheme;
}

export function detectOriginWarnings(origin: string): OriginWarning[] {
  if (typeof origin !== "string" || origin.length === 0) {
    return [
      {
        level: "danger",
        code: "missing-origin",
        text: "Request has no origin — refuse this connection.",
      },
    ];
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return [
      {
        level: "danger",
        code: "malformed-origin",
        text: "Origin is not a valid URL — refuse this connection.",
      },
    ];
  }

  const out: OriginWarning[] = [];
  // `parsed.hostname` IDN-to-ASCIIs any non-ASCII chars to xn--… form,
  // so it's the right surface for the punycode and TLD checks. The raw
  // origin still carries the original Unicode (or xn-- the dApp sent),
  // so we use it for the homograph check.
  const hostname = parsed.hostname.toLowerCase();
  const rawHost = extractRawHostname(origin).toLowerCase();

  // 1. Plain HTTP (or any non-https / non-localhost). file:// and chrome-
  //    extension:// origins also get flagged — they're rare in real
  //    dApp flows and merit a heads-up.
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost");
  if (parsed.protocol !== "https:" && !isLocalhost) {
    out.push({
      level: "danger",
      code: "non-https",
      text: `Connection is over ${parsed.protocol.replace(":", "")} — credentials can be intercepted. HTTPS is the minimum bar.`,
    });
  }

  // 2. IDN / punycode. The browser already shows xn--… in the address
  //    bar, but on the approval screen we want explicit copy. We check
  //    BOTH the IDN-to-ASCII'd hostname (catches Unicode-input origins
  //    auto-converted by URL) and the raw origin (catches origins the
  //    dApp sent verbatim in xn-- form).
  if (hostname.includes("xn--") || rawHost.includes("xn--")) {
    out.push({
      level: "danger",
      code: "punycode",
      text: "Hostname uses punycode (xn--…). This is a common spoofing technique — verify the domain matches what you expect.",
    });
  }

  // 3. Homograph: Cyrillic/Greek lookalike characters in the raw hostname.
  //    URL.hostname has already IDN-to-ASCII'd these so we check the
  //    pre-parse string.
  if (HOMOGRAPH_RE.test(rawHost)) {
    out.push({
      level: "danger",
      code: "homograph",
      text: "Hostname contains characters that resemble Latin letters but aren't. This is a homograph spoof.",
    });
  }

  // 4. Brand lookalike: hostname contains a known crypto brand fragment
  //    but isn't on the canonical-brand-host list.
  const canonicalMatch = CANONICAL_BRAND_HOSTS.some(
    (b) => hostname === b || hostname.endsWith(`.${b}`),
  );
  if (!canonicalMatch) {
    const matchedBrand = BRAND_FRAGMENTS.find((b) => hostname.includes(b));
    if (matchedBrand !== undefined) {
      out.push({
        level: "danger",
        code: "brand-lookalike",
        text: `Hostname looks like "${matchedBrand}" but isn't the canonical domain — this is a typical phishing pattern.`,
      });
    }
  }

  // 5. Risky TLD on a non-canonical domain. Lower severity since plenty
  //    of legitimate dApps use these for short URLs — but pair with the
  //    brand-lookalike signal it becomes a stronger flag.
  const lastDot = hostname.lastIndexOf(".");
  const tld = lastDot >= 0 ? hostname.slice(lastDot + 1) : "";
  if (tld.length > 0 && RISKY_TLDS.has(tld) && !canonicalMatch) {
    out.push({
      level: "warning",
      code: "risky-tld",
      text: `Top-level domain .${tld} is frequently used by short-lived phishing sites — double-check the URL.`,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Message-payload heuristics (personal_sign)
// ─────────────────────────────────────────────────────────────────────────────

/** A hex string that *looks* like ABI-encoded calldata: 0x + 8-char
 *  selector + a multiple of 64 hex chars for the args. Length is the
 *  forcing function — random hex text would have to be a clean multiple
 *  of 64 + 8 for this to false-positive. */
const ABI_SHAPE_RE = /^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})+$/;

/** Permit / Permit2 telltales appearing in EIP-191 messages an attacker
 *  may try to slip past via personal_sign rather than typed_sign. */
const PERMIT_KEYWORDS = [
  "Permit2",
  "Permit(",
  "approve(",
  "transferFrom(",
  "setApprovalForAll(",
];

export function detectMessageWarnings(message: string): MessageWarning[] {
  if (typeof message !== "string") return [];
  if (message.length === 0) return [];

  const out: MessageWarning[] = [];
  const isHex = message.startsWith("0x") || message.startsWith("0X");

  // 1. ABI-shaped hex: someone is asking you to "sign a message" that
  //    looks like the raw bytes of a contract call. Refusing is almost
  //    always the right answer.
  if (isHex && ABI_SHAPE_RE.test(message)) {
    out.push({
      level: "danger",
      code: "abi-shaped-hex",
      text: "Payload looks like ABI-encoded calldata (selector + 32-byte arguments). Signing this as a 'message' may authorize a contract call you didn't intend.",
    });
  }

  // 2. Binary hex blob — printable bytes are the common case, binary is
  //    suspicious. Use the same printability check the popup uses for
  //    the personal_sign preview: if decoded bytes aren't printable
  //    ASCII (or extended-Latin), flag it.
  if (isHex && message.length > 2 && !out.some((w) => w.code === "abi-shaped-hex")) {
    const utf8 = tryDecodeHexUtf8(message);
    if (utf8 === null) {
      out.push({
        level: "warning",
        code: "binary-hex",
        text: "Payload decodes to non-printable bytes — review the raw hex carefully before signing.",
      });
    }
  }

  // 3. Permit / Permit2 keywords. Surface even on non-hex (text) bodies
  //    because some address-grabber sites use legitimate-looking text
  //    that includes a permit clause.
  const haystack = isHex ? (tryDecodeHexUtf8(message) ?? "") : message;
  if (haystack.length > 0) {
    for (const k of PERMIT_KEYWORDS) {
      if (haystack.includes(k)) {
        out.push({
          level: "danger",
          code: "permit-keyword",
          text: `Payload contains "${k}" — this is the structure address-grabber phishing uses to drain token allowances. Permits should normally be sent through eth_signTypedData_v4, not personal_sign.`,
        });
        break; // one keyword warning is enough
      }
    }
  }

  // 4. Oversized payload. Legitimate sign-in / SIWE messages fit in a
  //    paragraph. >4 KB is a red flag.
  if (message.length > 4096) {
    out.push({
      level: "warning",
      code: "oversized-payload",
      text: "Payload is unusually large (>4 KB). Legitimate sign-in flows fit in a few hundred bytes — this may be obfuscation.",
    });
  }

  return out;
}

/** Decode a 0x-hex string as UTF-8. Returns null when the bytes aren't
 *  printable ASCII / latin-1 (binary blob), matching the existing
 *  preview behaviour in components.tsx:previewMessage. */
function tryDecodeHexUtf8(message: string): string | null {
  if (!message.startsWith("0x") && !message.startsWith("0X")) return null;
  if (message.length < 4 || (message.length - 2) % 2 !== 0) return null;
  try {
    const bytes = new Uint8Array((message.length - 2) / 2);
    for (let i = 0; i < bytes.length; i++) {
      const hi = parseInt(message.charAt(2 + i * 2), 16);
      const lo = parseInt(message.charAt(3 + i * 2), 16);
      if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
      bytes[i] = (hi << 4) | lo;
    }
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (/^[\x20-\x7E\n\r\t]*$/.test(text)) return text;
    return null;
  } catch {
    return null;
  }
}
