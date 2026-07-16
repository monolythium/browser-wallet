import { describe, expect, it } from "vitest";
import type { WalletAuthRequestV1 } from "../shared/wallet-auth.js";
import {
  bindWalletAuthApprovalSnapshot,
  walletAuthApprovalStateMatches,
} from "./wallet-auth-approval.js";

const challenge: WalletAuthRequestV1 = {
  version: "1",
  domain: "stele.example",
  origin: "https://stele.example",
  uri: "https://stele.example/",
  chainId: "69420",
  genesisHash: `0x${"ab".repeat(32)}`,
  nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  issuedAt: "2026-07-16T11:59:30.000Z",
  expirationTime: "2026-07-16T12:01:30.000Z",
  scopes: ["stele:web:session"],
};

const state = {
  vaultId: "vault-1",
  address: "0x1111111111111111111111111111111111111111",
  chainId: challenge.chainId,
  genesisHash: challenge.genesisHash,
};

describe("wallet authentication approval snapshot", () => {
  it("binds the exact displayed account and privileged network state", () => {
    expect(bindWalletAuthApprovalSnapshot(challenge, state.address, state)).toEqual(state);
  });

  it("rejects a stale/spoofed displayed account", () => {
    expect(
      bindWalletAuthApprovalSnapshot(
        challenge,
        "0x2222222222222222222222222222222222222222",
        state,
      ),
    ).toBeNull();
  });

  it("rejects locked, wrong-chain, and wrong-genesis state", () => {
    expect(bindWalletAuthApprovalSnapshot(challenge, state.address, null)).toBeNull();
    expect(
      bindWalletAuthApprovalSnapshot(challenge, state.address, {
        ...state,
        chainId: "1",
      }),
    ).toBeNull();
    expect(
      bindWalletAuthApprovalSnapshot(challenge, state.address, {
        ...state,
        genesisHash: `0x${"cd".repeat(32)}`,
      }),
    ).toBeNull();
  });

  it("detects any post-approval vault, address, or network change", () => {
    expect(walletAuthApprovalStateMatches(state, { ...state })).toBe(true);
    for (const changed of [
      { ...state, vaultId: "vault-2" },
      { ...state, address: "0x2222222222222222222222222222222222222222" },
      { ...state, chainId: "1" },
      { ...state, genesisHash: `0x${"cd".repeat(32)}` },
      null,
    ]) {
      expect(walletAuthApprovalStateMatches(state, changed)).toBe(false);
    }
  });
});
