// Shared types + validator for the chain's
// `lyth_indexerStatus` response. Lives at shared/ because the popup
// uses these types (via bgWalletIndexerStatus) and the SW uses the
// validator. Keeping both in one file means the wire-shape contract
// stays consistent across the IPC boundary.
//
// Chain commits this commit consumes:
//   - 94cf845 — lyth_indexerStatus envelope + IndexerRetentionStatus
//   - 9d59c3f — wallet-detectable schema drift via schemaVersion
//   - b02033b — live indexer snapshots in the projection layer
//   - a097622 — canonical receipts in the indexer (consumed indirectly
//                through the existing activity feed)

/** Wallet-side mirror of the chain's IndexerRetentionStatus. */
export interface IndexerRetentionInfo {
  archive: boolean;
  retentionBlocks: number | null;
  archiveRedirect: string | null;
}

/** Wallet-side validated IndexerStatus envelope. JSON numbers (the wire
 *  reality) rather than bigints, since both sides of the IPC boundary
 *  serialise via chrome.storage which doesn't carry bigints. */
export interface IndexerStatusValidated {
  currentHeight: number;
  latestHeight: number | null;
  /** Schema version chain reports. 0 when missing (older chain build). */
  schemaVersion: number;
  /** Optional retention envelope (chain commit 94cf845). */
  retention: IndexerRetentionInfo | null;
}

/** The schema version this wallet build was tested against. Bump when
 *  shipping parsers for a newer chain schema.
 *
 *  Bumped 1 -> 6 -> 7. The BIP-39 re-genesis advanced the indexer schema
 *  6 -> 7; a live probe (2026-06-28, genesis `0xaabb0f1e`, height 19862)
 *  returned `lyth_indexerStatus.schemaVersion = 7` on all 6 genesis-verified
 *  operators. The 6 -> 7 delta is ADDITIVE — a new `retention.earliestRetained`
 *  field the wallet silently drops; the activity-feed parsers handle the
 *  schema-7 payload completely (every field `RawAddressActivity` /
 *  `validateRawAddressActivity` reads is present + correctly typed). The
 *  parsers are additive (unknown fields silently dropped — see the docstring
 *  above on `isSchemaDrift`), so forward-compat with versions 2..7 is the
 *  design promise; bumping the gate to 7 honours that promise and clears the
 *  false-positive IndexerStaleBanner that fired on every Activity-tab open. */
export const WALLET_KNOWN_INDEXER_SCHEMA_VERSION = 7;

/** Returns true when the chain reports a schema newer than the wallet
 *  knows. The activity-feed parsers are additive (unknown fields are
 *  silently dropped), so drift doesn't break the render — but the user
 *  should be advised. */
export function isSchemaDrift(schemaVersion: number): boolean {
  return schemaVersion > WALLET_KNOWN_INDEXER_SCHEMA_VERSION;
}

/** Permissive validator. Returns null on malformed input — caller falls
 *  back to a defensive default rather than failing the IPC. */
export function validateIndexerStatusWire(
  input: unknown,
): IndexerStatusValidated | null {
  if (input === null || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (typeof r.currentHeight !== "number" || !Number.isFinite(r.currentHeight)) {
    return null;
  }
  let latestHeight: number | null = null;
  if (r.latestHeight !== undefined && r.latestHeight !== null) {
    if (typeof r.latestHeight !== "number" || !Number.isFinite(r.latestHeight)) {
      return null;
    }
    latestHeight = r.latestHeight;
  }
  const schemaVersion =
    typeof r.schemaVersion === "number" && Number.isFinite(r.schemaVersion)
      ? r.schemaVersion
      : 0;
  let retention: IndexerRetentionInfo | null = null;
  if (
    r.retention !== undefined &&
    r.retention !== null &&
    typeof r.retention === "object"
  ) {
    const ret = r.retention as Record<string, unknown>;
    retention = {
      archive: ret.archive === true,
      retentionBlocks:
        typeof ret.retentionBlocks === "number" && Number.isFinite(ret.retentionBlocks)
          ? ret.retentionBlocks
          : null,
      archiveRedirect:
        typeof ret.archiveRedirect === "string" ? ret.archiveRedirect : null,
    };
  }
  return { currentHeight: r.currentHeight, latestHeight, schemaVersion, retention };
}
