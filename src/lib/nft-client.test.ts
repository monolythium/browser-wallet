// Phase 5 Commit 5 — nft-client tests.
//
// No popup-side React test infra is wired up yet (Phase 8 hardening),
// so these tests run in the standard vitest Node env. The chrome
// stub mirrors the keystore-mldsa.test.ts pattern (callback-style
// chrome.storage.local) so the production code's `chrome.storage.local
// .get(..., cb)` Promise-wrapping path exercises identically.
//
// Network-touching paths (fetchNftMetadata via fetch, fetchOrCacheNftMetadata
// when the cache misses) are not covered here — the wallet has no
// project-wide fetch mock harness; live fetch coverage belongs to
// the integration suite. The unit surface tested:
//   - Calldata encoding round-trip (selectors + ABI head/tail layout)
//   - ERC-165 supportsInterface for ERC-721 and ERC-1155
//   - IPFS URI resolution + safe scheme allow-listing
//   - ERC-1155 {id} placeholder substitution
//   - Pin / unpin round-trip across the chrome.storage stub
//   - 24h TTL cache eviction (fresh + expired branches)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  IPFS_GATEWAYS,
  INTERFACE_ID_ERC1155,
  INTERFACE_ID_ERC721,
  METADATA_TTL_MS,
  encodeErc1155SafeTransferFrom,
  encodeErc721TransferFrom,
  evictExpiredMetadataCache,
  fnSelector,
  getCachedNftMetadata,
  loadPinnedNfts,
  pinNft,
  putCachedNftMetadata,
  resolveIpfsUri,
  sanitizeImageUri,
  substituteErc1155IdPlaceholder,
  supportsErc1155,
  supportsErc721,
  unpinNft,
  type EthCaller,
  type NftMetadata,
} from "./nft-client.js";

interface StorageMap {
  [k: string]: unknown;
}

function installChromeStub(): { storage: StorageMap } {
  const storage: StorageMap = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (
          keys: string[],
          cb: (res: Record<string, unknown>) => void,
        ) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) {
            if (k in storage) out[k] = storage[k];
          }
          queueMicrotask(() => cb(out));
        },
        set: (entries: Record<string, unknown>, cb: () => void) => {
          for (const [k, v] of Object.entries(entries)) {
            storage[k] = v;
          }
          queueMicrotask(() => cb());
        },
      },
    },
  };
  return { storage };
}

beforeEach(() => {
  installChromeStub();
});
afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

// ---------------------------------------------------------------------------
// Calldata encoding
// ---------------------------------------------------------------------------

describe("calldata encoding", () => {
  // The selector for ownerOf(uint256) is the first 4 bytes of
  // keccak256("ownerOf(uint256)") — recompute here so the test
  // proves the helper computes it (rather than re-asserting a
  // copy-pasted constant).
  function expectedSelector(sig: string): string {
    return bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
  }

  it("fnSelector matches keccak256(sig)[0..4]", () => {
    expect(fnSelector("ownerOf(uint256)")).toBe(
      expectedSelector("ownerOf(uint256)"),
    );
    expect(fnSelector("balanceOf(address)")).toBe(
      expectedSelector("balanceOf(address)"),
    );
    expect(fnSelector("balanceOf(address,uint256)")).toBe(
      expectedSelector("balanceOf(address,uint256)"),
    );
    expect(fnSelector("uri(uint256)")).toBe(expectedSelector("uri(uint256)"));
  });

  it("encodeErc721TransferFrom: selector + 32-byte from + 32-byte to + 32-byte tokenId", () => {
    const from = "0x1111111111111111111111111111111111111111";
    const to = "0x2222222222222222222222222222222222222222";
    const tokenId = 123n;

    const data = encodeErc721TransferFrom(from, to, tokenId);
    // 0x + 8 hex (selector) + 64 + 64 + 64 = 0x + 200 hex
    expect(data.length).toBe(2 + 8 + 64 * 3);
    expect(data.startsWith("0x" + expectedSelector("transferFrom(address,address,uint256)"))).toBe(true);

    const body = data.slice(2 + 8);
    // address: zero-padded left to 32 bytes — 24 zero hex chars + 40 hex address
    expect(body.slice(0, 24)).toBe("0".repeat(24));
    expect(body.slice(24, 64)).toBe("1".repeat(40));
    expect(body.slice(64, 64 + 24)).toBe("0".repeat(24));
    expect(body.slice(64 + 24, 128)).toBe("2".repeat(40));
    // tokenId 123 = 0x7b — left-padded to 32 bytes
    expect(BigInt("0x" + body.slice(128, 192))).toBe(123n);
  });

  it("encodeErc1155SafeTransferFrom lays out static head + empty data tail", () => {
    const from = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const to = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const data = encodeErc1155SafeTransferFrom(from, to, 7n, 1n);

    // head: 4-byte selector + 5 * 32-byte slots = 8 + 320 hex
    // tail: 1 * 32-byte length(0) = 64 hex
    expect(data.length).toBe(2 + 8 + 320 + 64);
    expect(
      data.startsWith(
        "0x" +
          expectedSelector(
            "safeTransferFrom(address,address,uint256,uint256,bytes)",
          ),
      ),
    ).toBe(true);

    const body = data.slice(2 + 8);
    expect(BigInt("0x" + body.slice(0, 64))).toBe(BigInt("0x" + "a".repeat(40)));
    expect(BigInt("0x" + body.slice(64, 128))).toBe(BigInt("0x" + "b".repeat(40)));
    expect(BigInt("0x" + body.slice(128, 192))).toBe(7n);   // tokenId
    expect(BigInt("0x" + body.slice(192, 256))).toBe(1n);   // amount
    expect(BigInt("0x" + body.slice(256, 320))).toBe(160n); // dataOffset = 5*32
    expect(BigInt("0x" + body.slice(320, 384))).toBe(0n);   // dataLength
  });

  it("ownerOf calldata round-trip — selector + 32-byte uint256 tokenId", () => {
    // Build the selector + encoded tokenId by hand and compare to
    // what the helpers produce when wired to the same path.
    const sig = "ownerOf(uint256)";
    const sel = bytesToHex(keccak_256(new TextEncoder().encode(sig))).slice(0, 8);
    const padded = (123n).toString(16).padStart(64, "0");
    const expected = "0x" + sel + padded;

    // The transferFrom helper exists as a public exporter of the
    // same encoding pipeline; we reuse its lower-level pieces by
    // composing manually here to avoid exposing private encoders.
    const helperSel = "0x" + fnSelector("ownerOf(uint256)") + padded;
    expect(helperSel).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// ERC-165 supportsInterface
// ---------------------------------------------------------------------------

describe("supportsInterface", () => {
  /** Mock EthCaller that returns a configured boolean for any
   *  supportsInterface call by reading the requested interface id
   *  out of the calldata. */
  function makeMockCaller(
    supports: Record<string, boolean>,
  ): EthCaller & { calls: Array<{ to: string; data: string }> } {
    const calls: Array<{ to: string; data: string }> = [];
    return {
      calls,
      ethCall: async (req) => {
        calls.push(req);
        // calldata: 0x + 4-byte selector + 4-byte interface id + 28-byte right-pad
        const body = req.data.slice(2 + 8);
        const interfaceId = body.slice(0, 8); // first 4 bytes after selector
        const truthy = supports[interfaceId] ?? false;
        return "0x" + (truthy ? "1" : "0").padStart(64, "0");
      },
    };
  }

  it("supportsInterface(0xd9b67a26) → reports ERC-1155", async () => {
    const caller = makeMockCaller({ [INTERFACE_ID_ERC1155]: true });
    expect(await supportsErc1155(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(true);
    expect(caller.calls.length).toBe(1);
    expect(caller.calls[0]!.data.slice(2 + 8, 2 + 8 + 8)).toBe(INTERFACE_ID_ERC1155);
  });

  it("supportsInterface(0x80ac58cd) → reports ERC-721", async () => {
    const caller = makeMockCaller({ [INTERFACE_ID_ERC721]: true });
    expect(await supportsErc721(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(true);
    expect(caller.calls[0]!.data.slice(2 + 8, 2 + 8 + 8)).toBe(INTERFACE_ID_ERC721);
  });

  it("returns false when contract does not advertise the interface", async () => {
    const caller = makeMockCaller({});
    expect(await supportsErc721(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(false);
    expect(await supportsErc1155(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(false);
  });

  it("returns false when ethCall throws (revert / network)", async () => {
    const caller: EthCaller = {
      ethCall: async () => {
        throw new Error("revert");
      },
    };
    expect(await supportsErc721(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(false);
    expect(await supportsErc1155(caller, "0xc0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPFS URI resolution
// ---------------------------------------------------------------------------

describe("resolveIpfsUri", () => {
  it("ipfs://CID/path → primary gateway URL", () => {
    expect(resolveIpfsUri("ipfs://QmCid123/image.png")).toBe(
      `${IPFS_GATEWAYS[0]}QmCid123/image.png`,
    );
  });

  it("https:// passes through unchanged", () => {
    const url = "https://example.com/meta.json";
    expect(resolveIpfsUri(url)).toBe(url);
  });

  it("data:image/png base64 passes through", () => {
    const data = "data:image/png;base64,iVBORw0KGgo=";
    expect(resolveIpfsUri(data)).toBe(data);
  });

  it("data:image/svg+xml is rejected (script-injection vector)", () => {
    expect(resolveIpfsUri("data:image/svg+xml,<svg/>")).toBeNull();
  });

  it("http:// and javascript: are rejected", () => {
    expect(resolveIpfsUri("http://example.com/meta.json")).toBeNull();
    expect(resolveIpfsUri("javascript:alert(1)")).toBeNull();
  });

  it("ipfs CIDs containing path-traversal or query chars are rejected", () => {
    expect(resolveIpfsUri("ipfs://Qm../escape")).toBeNull();
    expect(resolveIpfsUri("ipfs://QmCid?x=1")).toBeNull();
    expect(resolveIpfsUri("ipfs://QmCid#frag")).toBeNull();
  });

  it("sanitizeImageUri delegates to resolveIpfsUri", () => {
    expect(sanitizeImageUri("ipfs://QmCid/img.png")).toBe(
      `${IPFS_GATEWAYS[0]}QmCid/img.png`,
    );
    expect(sanitizeImageUri(undefined)).toBeNull();
    expect(sanitizeImageUri("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ERC-1155 {id} placeholder substitution
// ---------------------------------------------------------------------------

describe("substituteErc1155IdPlaceholder", () => {
  it("substitutes {id} with 64-char zero-padded lowercase hex", () => {
    expect(substituteErc1155IdPlaceholder("ipfs://Qm/{id}.json", 1n)).toBe(
      "ipfs://Qm/" + "0".repeat(63) + "1.json",
    );
  });

  it("substitutes large token ids correctly", () => {
    const tokenId = 0xdeadbeefn;
    expect(substituteErc1155IdPlaceholder("https://api/{id}", tokenId)).toBe(
      "https://api/" + "0".repeat(56) + "deadbeef",
    );
  });

  it("replaces every occurrence", () => {
    expect(
      substituteErc1155IdPlaceholder("https://{id}/path/{id}.json", 5n),
    ).toBe(
      "https://" +
        "0".repeat(63) +
        "5/path/" +
        "0".repeat(63) +
        "5.json",
    );
  });

  it("idempotent for URIs without the placeholder", () => {
    expect(substituteErc1155IdPlaceholder("ipfs://Qm/0.json", 0n)).toBe(
      "ipfs://Qm/0.json",
    );
  });
});

// ---------------------------------------------------------------------------
// Pinning storage
// ---------------------------------------------------------------------------

describe("pinning storage", () => {
  it("loadPinnedNfts returns [] when nothing stored", async () => {
    expect(await loadPinnedNfts()).toEqual([]);
  });

  it("pinNft + loadPinnedNfts round-trip", async () => {
    await pinNft({
      chainId: 6940,
      address: "0xAaA00000000000000000000000000000000000Aa",
      tokenId: "1",
    });
    const all = await loadPinnedNfts();
    expect(all.length).toBe(1);
    expect(all[0]!.tokenId).toBe("1");
  });

  it("pinNft is idempotent across casing", async () => {
    await pinNft({ chainId: 1, address: "0xAaA0", tokenId: "1" });
    await pinNft({ chainId: 1, address: "0xaaa0", tokenId: "1" });
    expect((await loadPinnedNfts()).length).toBe(1);
  });

  it("unpinNft removes a pinned entry", async () => {
    await pinNft({ chainId: 1, address: "0xAaA0", tokenId: "42" });
    await pinNft({ chainId: 1, address: "0xBbB0", tokenId: "7" });
    await unpinNft(1, "0xAAA0", "42");
    const all = await loadPinnedNfts();
    expect(all.length).toBe(1);
    expect(all[0]!.address).toBe("0xBbB0");
  });

  it("unpinNft is a no-op when no match", async () => {
    await pinNft({ chainId: 1, address: "0xAaA0", tokenId: "1" });
    await unpinNft(1, "0xCcC0", "1");
    expect((await loadPinnedNfts()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 24h TTL metadata cache
// ---------------------------------------------------------------------------

describe("metadata cache", () => {
  const contract = "0xC0ffeeC0ffeeC0ffeeC0ffeeC0ffeeC0ffeeC0Ff";
  const tokenId = 99n;
  const meta: NftMetadata = {
    name: "Test",
    description: "desc",
    image: "ipfs://QmImg",
  };

  it("put + get within TTL returns cached value", async () => {
    const t0 = 1_000_000_000_000;
    await putCachedNftMetadata(contract, tokenId, meta, t0);
    const got = await getCachedNftMetadata(contract, tokenId, t0 + 60_000);
    expect(got?.name).toBe("Test");
    expect(got?.image).toBe("ipfs://QmImg");
  });

  it("get past TTL returns null and evicts the entry", async () => {
    const t0 = 1_000_000_000_000;
    await putCachedNftMetadata(contract, tokenId, meta, t0);
    const expired = await getCachedNftMetadata(
      contract,
      tokenId,
      t0 + METADATA_TTL_MS,
    );
    expect(expired).toBeNull();
    // Subsequent read at t0+1 (well within TTL of the original
    // write) should also be null because the expired path evicted.
    const after = await getCachedNftMetadata(contract, tokenId, t0 + 1);
    expect(after).toBeNull();
  });

  it("evictExpiredMetadataCache drops only stale entries", async () => {
    const t0 = 1_000_000_000_000;
    await putCachedNftMetadata(contract, 1n, meta, t0);
    await putCachedNftMetadata(contract, 2n, meta, t0 + 60_000);
    await putCachedNftMetadata(contract, 3n, meta, t0 + METADATA_TTL_MS - 1);

    // At t0 + TTL: the first entry is exactly at TTL → expired;
    // the third is at TTL-1 → still fresh; the second is at TTL-60s → fresh.
    const evicted = await evictExpiredMetadataCache(t0 + METADATA_TTL_MS);
    expect(evicted).toBe(1);
    expect(await getCachedNftMetadata(contract, 1n, t0 + METADATA_TTL_MS)).toBeNull();
    expect(await getCachedNftMetadata(contract, 2n, t0 + METADATA_TTL_MS)).not.toBeNull();
    expect(await getCachedNftMetadata(contract, 3n, t0 + METADATA_TTL_MS)).not.toBeNull();
  });

  it("address case is normalised for cache lookup", async () => {
    const t0 = 1_000_000_000_000;
    await putCachedNftMetadata(contract, tokenId, meta, t0);
    // lookup with all-lowercase address — same key
    const got = await getCachedNftMetadata(contract.toLowerCase(), tokenId, t0);
    expect(got?.name).toBe("Test");
  });
});
