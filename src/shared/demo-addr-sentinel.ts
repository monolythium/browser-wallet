// Demo-data address sentinels.
//
// `popup/demo-data.ts` ACCOUNTS seeds the popup's render state with a
// short fixture list before `bgWalletActiveAccount()` resolves the
// real unlocked vault address. Three of those fixture addresses are
// `0x`-shaped (the public-denom entries) and look identical to real
// chain addresses to any consumer that filters on `addr.startsWith("0x")`:
//
//   ACCOUNTS[0].addr = 0xa9f2000000000000000000000000000000000001
//   ACCOUNTS[2].addr = 0x77bd000000000000000000000000000000000003
//   ACCOUNTS[3].addr = 0xc9a3000000000000000000000000000000000004
//
// ACCOUNTS[1].addr = "mvk:john:cold:8841" is non-`0x`-shaped and
// already filtered out by the hex-prefix guard the address-keyed
// hooks use, so it can't leak.
//
// The popup-boot race between the demo-seeded initial state and the
// `wallet-active-account` IPC resolving the real address let
// per-address caches (activity, balance pins, name resolutions, etc.)
// fire against the demo placeholder. A storage dump on 2026-05-26
// captured `mono.activity.0xa9f2000000000000000000000000000000000001.0x10F2C`
// already on disk. Address-keyed write paths consult this sentinel
// list to short-circuit before producing stale cache rows; the
// service-worker boot path additionally scans `chrome.storage.local`
// for already-leaked sentinel keys and removes them on each cold
// start.

export const DEMO_ADDR_SENTINELS_LOWER: ReadonlyArray<string> = [
  "0xa9f2000000000000000000000000000000000001",
  "0x77bd000000000000000000000000000000000003",
  "0xc9a3000000000000000000000000000000000004",
];

const SENTINEL_SET = new Set<string>(DEMO_ADDR_SENTINELS_LOWER);

/** Returns true when `addr` is one of the known popup demo-data
 *  fixture addresses. Lowercases the input so callers don't have to
 *  normalize first. Null / undefined returns false. */
export function isDemoAddrSentinel(addr: string | null | undefined): boolean {
  if (typeof addr !== "string" || addr.length === 0) return false;
  return SENTINEL_SET.has(addr.toLowerCase());
}
