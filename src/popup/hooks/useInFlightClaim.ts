// In-flight reward-claim detector (popup-side).
//
// A claim in flight is a durable `source:"local-claim"` pending row with NO
// `confirmedBlockHeight` yet (the broadcast landed, the receipt hasn't). The
// persistence fix (9cfcf0b/34dbdb5) makes that row reliable across the 30s
// alarm + page-nav, so this is a trustworthy double-submit signal — and because
// it reads PERSISTED storage (not ephemeral component state), it survives a
// popup close→reopen. Mirrors the App.tsx hasPendingTx storage-watch idiom.

import { useEffect, useState } from "react";

import {
  activityPendingKey,
  validatePendingActivityCache,
  type PendingTxRow,
} from "../../shared/activity.js";

/** True when any pending row is an IN-FLIGHT reward claim: a
 *  `source:"local-claim"` row that has NOT yet been receipt-bridged
 *  (`confirmedBlockHeight` undefined). Pure + exported for unit coverage; the
 *  hook below wraps it over the live pending cache. */
export function hasInFlightClaim(rows: PendingTxRow[]): boolean {
  return rows.some(
    (p) => p.source === "local-claim" && p.confirmedBlockHeight === undefined,
  );
}

/** True when the claim with `txHash` has been receipt-bridged
 *  (`confirmedBlockHeight` set) in the pending cache — the signal to auto-dismiss
 *  the claim success surface. Pure + exported for unit coverage. Returns false
 *  when `txHash` is null (no success surface open). */
export function isClaimConfirmed(
  rows: PendingTxRow[],
  txHash: string | null,
): boolean {
  if (txHash === null) return false;
  return rows.some(
    (p) =>
      p.txHash === txHash &&
      p.source === "local-claim" &&
      p.confirmedBlockHeight !== undefined,
  );
}

/** True while a reward claim for (addr, chainIdHex) is in flight — a
 *  `source:"local-claim"` pending row with no `confirmedBlockHeight`. Flips
 *  false once the receipt bridge stamps `confirmedBlockHeight` (claim confirmed)
 *  or no such row exists. Used to gate the "Claim all" button against a
 *  double-broadcast, including after a popup close→reopen. */
export function useInFlightClaim(addr: string, chainIdHex: string): boolean {
  const [inFlight, setInFlight] = useState(false);
  useEffect(() => {
    if (!addr.startsWith("0x")) {
      setInFlight(false);
      return;
    }
    const key = activityPendingKey(addr.toLowerCase(), chainIdHex);
    let cancelled = false;
    const apply = (raw: unknown) => {
      if (cancelled) return;
      const rows = validatePendingActivityCache(raw)?.pending ?? [];
      setInFlight(hasInFlightClaim(rows));
    };
    chrome.storage.local.get([key], (res) => apply(res?.[key]));
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      if (key in changes) apply(changes[key]?.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [addr, chainIdHex]);
  return inFlight;
}

/** True once the claim with `txHash` has confirmed (its pending row is
 *  receipt-bridged with `confirmedBlockHeight`). Watches the pending cache via
 *  the same storage-watch idiom; pass `txHash = null` to disarm (no open
 *  success surface). Drives the success-surface auto-dismiss. */
export function useClaimConfirmed(
  addr: string,
  chainIdHex: string,
  txHash: string | null,
): boolean {
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (txHash === null || !addr.startsWith("0x")) {
      setConfirmed(false);
      return;
    }
    const key = activityPendingKey(addr.toLowerCase(), chainIdHex);
    let cancelled = false;
    const apply = (raw: unknown) => {
      if (cancelled) return;
      const rows = validatePendingActivityCache(raw)?.pending ?? [];
      setConfirmed(isClaimConfirmed(rows, txHash));
    };
    chrome.storage.local.get([key], (res) => apply(res?.[key]));
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== "local") return;
      if (key in changes) apply(changes[key]?.newValue);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [addr, chainIdHex, txHash]);
  return confirmed;
}
