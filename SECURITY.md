# Security Policy

## Supported versions

Monolythium Wallet (browser) is currently in **preview** (`v0.x.y`). The first non-preview tag will define the supported-versions window. Until then, only the latest commit on `master` is considered current.

## Reporting a vulnerability

If you believe you've found a vulnerability in the browser wallet — particularly anything that could:

- exfiltrate the encrypted vault from `chrome.storage`, the password-derived KEK, the in-memory unlocked seed, or a recovery phrase outside the explicit reveal flow,
- bypass the password gate, the lockout ladder, or the auto-lock policy,
- cause the EIP-1193 provider to sign without going through the popup approval flow,
- forge or replay approval messages between the content-script bridge (isolated world) and the in-page provider (`MAIN` world),
- inject into the popup from a content script or dapp page,
- escalate from a content-script context into the service worker's command surface,
- corrupt or downgrade the network config (e.g. silently swap an operator RPC),
- escape the EIP-1193 chain-isolation boundary (cross-chain replay, wrong-chain signing without confirmation),
- bypass the wrong-password lockout (5-attempt cooldowns, etc.),
- leak the unlocked seed, an in-progress signing buffer, or a passkey usage event into a log or extension event,

please **do not open a public issue or PR**.

Email `security@monolythium.com` with:

1. A clear description of the issue.
2. Reproduction steps (or a proof-of-concept) against the latest `master`.
3. The commit SHA you tested against.
4. Your assessment of impact and any suggested mitigation.

We aim to acknowledge within 3 business days and to publish a fix within 30 days for high-severity findings.

## Disclosure

Coordinated disclosure is required for any finding affecting a signed extension release. For preview-tag findings, we'll work with you on timing — typically a fix lands on `master` first, then propagates to the published extension stores on the next release cycle, and the public disclosure follows.

## Out of scope

- Reports against builds older than the latest `master`.
- Reports requiring a malicious browser extension already installed alongside this one (browser sandbox + extension permissions are the boundary).
- Reports requiring a physical-attacker model (full filesystem access, keylogger, etc.).
- Reports requiring a malicious or compromised SDK / lyth-mcp / chain-registry (those are tracked in their own upstream security policies).
- Issues in upstream dependencies (`@noble/*`, `@scure/bip32`, `@scure/bip39`, `ethers`, etc.) — please report those upstream and we'll pick up the fix.
- Vulnerabilities in private Monolythium components (the chain itself, the SDK behind a sibling checkout, etc.) — please use the contact above; we'll route internally.

## What we won't do

- Reward bug reports with bounties. The wallet is not enrolled in a bug-bounty program at this stage. Public acknowledgment in release notes is the recognition we can offer.
- Run automated scans against your environment.
