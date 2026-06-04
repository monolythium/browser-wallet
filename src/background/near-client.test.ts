import { describe, expect, it } from "vitest";
import {
  nearJsonRpc,
  nearStatus,
  nearViewAccount,
  nearViewFtBalance,
} from "./near-client.js";

describe("near client", () => {
  it("reads /status from the configured RPC", async () => {
    const fetchImpl = async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://rpc.testnet.near.org/status");
      expect(init).toBeUndefined();
      return jsonResponse({
        chain_id: "testnet",
        latest_protocol_version: 1,
        protocol_version: 1,
        sync_info: {
          latest_block_hash: "hash",
          latest_block_height: 12,
          latest_state_root: "root",
          latest_block_time: "2026-01-01T00:00:00Z",
          syncing: false,
        },
        validators: [],
      });
    };

    await expect(nearStatus("https://rpc.testnet.near.org/", fetchImpl)).resolves.toMatchObject({
      chain_id: "testnet",
    });
  });

  it("posts JSON-RPC queries and fails on RPC errors", async () => {
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      expect(body.method).toBe("query");
      return jsonResponse({
        jsonrpc: "2.0",
        id: "monolythium-wallet",
        error: { message: "missing account" },
      });
    };

    await expect(
      nearJsonRpc("https://rpc.testnet.near.org", "query", {}, fetchImpl),
    ).rejects.toThrow("missing account");
  });

  it("builds native account balance queries", async () => {
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: Record<string, string> };
      expect(body.params).toMatchObject({
        request_type: "view_account",
        finality: "final",
        account_id: "alice.testnet",
      });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "monolythium-wallet",
        result: {
          amount: "1000",
          locked: "0",
          code_hash: "hash",
          storage_usage: 10,
          storage_paid_at: 0,
          block_height: 1,
          block_hash: "block",
        },
      });
    };

    await expect(
      nearViewAccount("https://rpc.testnet.near.org", "alice.testnet", fetchImpl),
    ).resolves.toMatchObject({ amount: "1000" });
  });

  it("builds NEP-141 balance queries", async () => {
    const balanceBytes = Array.from(new TextEncoder().encode(JSON.stringify("12345")));
    const fetchImpl = async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        params: { account_id: string; method_name: string; args_base64: string };
      };
      expect(body.params.account_id).toBe("wlyth.testnet");
      expect(body.params.method_name).toBe("ft_balance_of");
      expect(JSON.parse(atob(body.params.args_base64))).toEqual({
        account_id: "alice.testnet",
      });
      return jsonResponse({
        jsonrpc: "2.0",
        id: "monolythium-wallet",
        result: { result: balanceBytes },
      });
    };

    await expect(
      nearViewFtBalance(
        "https://rpc.testnet.near.org",
        "wlyth.testnet",
        "alice.testnet",
        fetchImpl,
      ),
    ).resolves.toBe("12345");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

