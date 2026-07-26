// One-shot migration for persisted state that is meaningful only on one
// incarnation of testnet-69420.
//
// Testnet keeps its chain id across a re-genesis. Keys that are scoped only by
// `(address, chainId)` can therefore contain predecessor-chain activity,
// pending transactions, notification dedupe/watermarks, balances, names, and
// liveness hints. A build carrying a new authoritative genesis identity clears
// those families once, then stamps the identity it migrated to.
//
// Custody and user-authored state are deliberately outside this allowlist:
// vaults, contacts, connected sites, custom chains, operator overrides, UI
// preferences, notification preferences, and local security-policy usage all
// survive the cut.

import {
  TESTNET_CHAIN_ID_HEX,
  TESTNET_GENESIS_HASH,
} from "../shared/build-info.js";

export const TESTNET_IDENTITY_STAMP_KEY =
  "mono.migration.testnet-identity.v1";

export const TESTNET_IDENTITY_STAMP = Object.freeze({
  schemaVersion: 0 as const,
  chainId: TESTNET_CHAIN_ID_HEX.toLowerCase(),
  genesisHash: TESTNET_GENESIS_HASH.toLowerCase(),
});

const REGENESIS_SENSITIVE_LOCAL_PREFIXES = [
  "mono.activity.",
  "mono.balance.",
  "mono.indexerStatus.",
  "mono.names.",
  "mono.notifications.history.",
  "mono.notifications.incoming-watermark.",
  "mono.notifications.notified.",
  "mono.sent-addrs.",
  "mono.ws.",
] as const;

const REGENESIS_SENSITIVE_SESSION_KEYS = [
  "mono.nonce.pending",
  "mono.session.genesis-cache.v2",
  "mono.session.operator.v1",
] as const;

export function isRegenesisSensitiveLocalKey(key: string): boolean {
  return REGENESIS_SENSITIVE_LOCAL_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
}

export async function migrateRegenesisSensitiveState(): Promise<boolean> {
  const stamped = await readLocal(TESTNET_IDENTITY_STAMP_KEY);
  if (matchesCurrentIdentity(stamped[TESTNET_IDENTITY_STAMP_KEY])) {
    return false;
  }

  const all = await readLocal(null);
  const localKeys = Object.keys(all).filter(isRegenesisSensitiveLocalKey);
  if (localKeys.length > 0) {
    await removeLocal(localKeys);
  }

  await removeSession([...REGENESIS_SENSITIVE_SESSION_KEYS]);
  await writeLocal({
    [TESTNET_IDENTITY_STAMP_KEY]: { ...TESTNET_IDENTITY_STAMP },
  });
  return true;
}

function matchesCurrentIdentity(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === TESTNET_IDENTITY_STAMP.schemaVersion &&
    record.chainId === TESTNET_IDENTITY_STAMP.chainId &&
    record.genesisHash === TESTNET_IDENTITY_STAMP.genesisHash
  );
}

function readLocal(
  keys: string | string[] | null,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result ?? {}));
  });
}

function removeLocal(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

function removeSession(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.session.remove(keys, () => resolve());
  });
}

function writeLocal(entries: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(entries, () => resolve());
  });
}
