// Phase 2 — OS toast + badge + click-handler coverage. Stubs
// `chrome.notifications`, `chrome.action`, `chrome.tabs`, and
// `chrome.storage.local` (the same in-memory pattern as keystore.test.ts
// + notifications-store.test.ts) so the real fireOsNotification /
// refreshUnreadBadge / handleNotificationClick are exercised under Node.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StorageMap {
  [k: string]: unknown;
}

interface ChromeStubCaptures {
  storage: StorageMap;
  notificationsCreate: Array<{ id: string; options: Record<string, unknown> }>;
  badgeText: string[];
  badgeColor: string[];
  tabsCreated: Array<{ url: string }>;
  notificationsCleared: string[];
}

function installChromeStub(opts: { failNotificationsCreate?: boolean } = {}): ChromeStubCaptures {
  const storage: StorageMap = {};
  const notificationsCreate: ChromeStubCaptures["notificationsCreate"] = [];
  const badgeText: string[] = [];
  const badgeColor: string[] = [];
  const tabsCreated: ChromeStubCaptures["tabsCreated"] = [];
  const notificationsCleared: string[] = [];

  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (
          keys: string | string[] | null,
          cb: (res: Record<string, unknown>) => void,
        ) => {
          if (keys === null) {
            queueMicrotask(() => cb({ ...storage }));
            return;
          }
          const arr = typeof keys === "string" ? [keys] : keys;
          const out: Record<string, unknown> = {};
          for (const k of arr) {
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
        remove: (keys: string | string[], cb?: () => void) => {
          const arr = typeof keys === "string" ? [keys] : keys;
          for (const k of arr) delete storage[k];
          if (cb) queueMicrotask(() => cb());
        },
      },
    },
    notifications: {
      create: vi.fn(async (id: string, options: Record<string, unknown>) => {
        if (opts.failNotificationsCreate) {
          throw new Error("simulated OS denial");
        }
        notificationsCreate.push({ id, options });
        return id;
      }),
      clear: vi.fn(async (id: string) => {
        notificationsCleared.push(id);
        return true;
      }),
      onClicked: {
        addListener: vi.fn(),
      },
    },
    action: {
      setBadgeText: vi.fn(async (params: { text: string }) => {
        badgeText.push(params.text);
      }),
      setBadgeBackgroundColor: vi.fn(async (params: { color: string }) => {
        badgeColor.push(params.color);
      }),
    },
    tabs: {
      create: vi.fn(async (params: { url: string }) => {
        tabsCreated.push(params);
        return { id: 1 };
      }),
    },
  };

  return {
    storage,
    notificationsCreate,
    badgeText,
    badgeColor,
    tabsCreated,
    notificationsCleared,
  };
}

const ADDR = "0x" + "ab".repeat(20);
const CHAIN = "0x10f2c";
const HASH = "0x" + "11".repeat(32);

function baseRecord(overrides: Partial<{
  kind: string;
  status: "confirmed" | "failed";
  amountDecimal: string;
  counterparty: string;
}> = {}) {
  return {
    id: `${CHAIN}:${HASH}`,
    txHash: HASH,
    status: overrides.status ?? ("confirmed" as const),
    blockNumber: 100 as number | null,
    kind: (overrides.kind ?? "delegate") as
      | "send"
      | "delegate"
      | "undelegate"
      | "redelegate"
      | "claim"
      | "emergency-key"
      | "agent-policy"
      | "contract_call",
    amountDecimal: overrides.amountDecimal ?? "0.10",
    counterparty:
      overrides.counterparty ?? "0x" + "01".repeat(20),
    createdAtMs: 1_700_000_000_000,
    read: false,
    schemaVersion: 0 as const,
  };
}

describe("fireOsNotification", () => {
  let captures: ChromeStubCaptures;

  beforeEach(() => {
    captures = installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("fires an OS toast with the friendly title from notificationTitle (confirmed delegate → 'Staked')", async () => {
    const { fireOsNotification } = await import("./notifications-os.js");
    const record = baseRecord({ kind: "delegate", status: "confirmed", amountDecimal: "0.10" });
    await fireOsNotification(record);

    expect(captures.notificationsCreate).toHaveLength(1);
    const call = captures.notificationsCreate[0]!;
    expect(call.id).toBe(`${CHAIN}:${HASH}`);
    expect(call.options.type).toBe("basic");
    expect(call.options.iconUrl).toBe("icon-48.png");
    expect(call.options.title).toBe("Staked");
    // body = amount + " LYTH · " + short bech32m counterparty
    expect(typeof call.options.message).toBe("string");
    expect(call.options.message as string).toContain("0.10 LYTH");
    // Short counterparty is rendered via bech32mDisplay + truncMiddle —
    // for a 0x address the display is the original 0x string (bech32mDisplay
    // tries to convert and returns input on non-20-byte test input).
    expect(call.options.message as string).toContain("·");
  });

  it("renders the failed wording from notificationTitle for status:'failed' (never 'confirmed')", async () => {
    const { fireOsNotification } = await import("./notifications-os.js");
    await fireOsNotification(
      baseRecord({ kind: "send", status: "failed", amountDecimal: "0.05" }),
    );
    expect(captures.notificationsCreate).toHaveLength(1);
    expect(captures.notificationsCreate[0]!.options.title).toBe("Send failed");
  });

  it("omits the amount from the body for zero-amount records (e.g. claim / agent-policy)", async () => {
    const { fireOsNotification } = await import("./notifications-os.js");
    await fireOsNotification(
      baseRecord({ kind: "claim", status: "confirmed", amountDecimal: "0" }),
    );
    expect(captures.notificationsCreate).toHaveLength(1);
    const msg = captures.notificationsCreate[0]!.options.message as string;
    // The body must NOT mention "0 LYTH" or "0.00 LYTH" — it should
    // just carry the short counterparty.
    expect(msg).not.toContain("LYTH");
    expect(msg).not.toContain("0 ");
    // Title still maps to the friendly label.
    expect(captures.notificationsCreate[0]!.options.title).toBe("Rewards claimed");
  });

  it("also omits the amount for '0.00' / '0.0000' (the formatter's zero forms)", async () => {
    const { fireOsNotification } = await import("./notifications-os.js");
    await fireOsNotification(
      baseRecord({ kind: "agent-policy", status: "confirmed", amountDecimal: "0.00" }),
    );
    const msg = captures.notificationsCreate[0]!.options.message as string;
    expect(msg).not.toContain("LYTH");
    expect(captures.notificationsCreate[0]!.options.title).toBe("Agent policy updated");
  });

  it("OS-deny degrade — chrome.notifications.create rejects → fireOsNotification swallows + no unhandled rejection", async () => {
    captures = installChromeStub({ failNotificationsCreate: true });
    vi.resetModules();
    const { fireOsNotification } = await import("./notifications-os.js");
    // Must NOT throw; the awaited promise resolves cleanly.
    await expect(
      fireOsNotification(baseRecord({ kind: "send", status: "confirmed" })),
    ).resolves.toBeUndefined();
  });
});

describe("refreshUnreadBadge", () => {
  let captures: ChromeStubCaptures;

  beforeEach(() => {
    captures = installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("sets the badge text to the unread count from getUnread()", async () => {
    // Seed a history blob with 2 unread + 1 read record. getUnread
    // aggregates unread across every history key.
    captures.storage[`mono.notifications.history.${ADDR}.${CHAIN}.v1`] = {
      schemaVersion: 0,
      entries: [
        baseRecord({ kind: "send" }),
        { ...baseRecord({ kind: "delegate" }), id: `${CHAIN}:0x22`, txHash: "0x22" },
        {
          ...baseRecord({ kind: "claim" }),
          id: `${CHAIN}:0x33`,
          txHash: "0x33",
          read: true,
        },
      ],
    };
    const { refreshUnreadBadge } = await import("./notifications-os.js");
    await refreshUnreadBadge();
    expect(captures.badgeText).toEqual(["2"]);
    // Non-zero count → background color also pushed.
    expect(captures.badgeColor).toHaveLength(1);
    expect(captures.badgeColor[0]).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("clears the badge (empty string) when there are no unread records", async () => {
    captures.storage[`mono.notifications.history.${ADDR}.${CHAIN}.v1`] = {
      schemaVersion: 0,
      entries: [
        { ...baseRecord({ kind: "send" }), read: true },
      ],
    };
    const { refreshUnreadBadge } = await import("./notifications-os.js");
    await refreshUnreadBadge();
    expect(captures.badgeText).toEqual([""]);
  });

  it("swallows badge-API errors (best-effort)", async () => {
    // Replace setBadgeText with a rejecting stub.
    (
      globalThis as { chrome?: { action?: { setBadgeText?: unknown } } }
    ).chrome!.action!.setBadgeText = vi.fn(async () => {
      throw new Error("badge denied");
    });
    const { refreshUnreadBadge } = await import("./notifications-os.js");
    await expect(refreshUnreadBadge()).resolves.toBeUndefined();
  });
});

describe("handleNotificationClick / parseTxHashFromNotificationId", () => {
  let captures: ChromeStubCaptures;

  beforeEach(() => {
    captures = installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("opens Monoscan in a new tab when the id carries a 0x tx hash", async () => {
    const { handleNotificationClick } = await import("./notifications-os.js");
    await handleNotificationClick(`${CHAIN}:${HASH}`);
    expect(captures.tabsCreated).toHaveLength(1);
    expect(captures.tabsCreated[0]!.url).toBe(`https://monoscan.xyz/#/tx/${HASH}`);
    // Also clears the notification.
    expect(captures.notificationsCleared).toContain(`${CHAIN}:${HASH}`);
  });

  it("does NOT open Monoscan for a malformed id (no 0x tail)", async () => {
    const { handleNotificationClick } = await import("./notifications-os.js");
    await handleNotificationClick("mono.notifications.unrelated-id");
    expect(captures.tabsCreated).toHaveLength(0);
  });

  it("parseTxHashFromNotificationId returns the txHash for valid ids, null for malformed", async () => {
    const { parseTxHashFromNotificationId } = await import("./notifications-os.js");
    expect(parseTxHashFromNotificationId(`${CHAIN}:${HASH}`)).toBe(HASH);
    expect(parseTxHashFromNotificationId("no-colon-no-0x")).toBeNull();
    expect(parseTxHashFromNotificationId("0xabc")).toBe("0xabc");
  });
});

describe("installNotificationsClickListener", () => {
  beforeEach(() => {
    installChromeStub();
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("registers a single onClicked listener at the chrome.notifications surface", async () => {
    const { installNotificationsClickListener } = await import(
      "./notifications-os.js"
    );
    installNotificationsClickListener();
    const stub = (
      globalThis as {
        chrome?: {
          notifications?: {
            onClicked?: { addListener?: { mock?: { calls?: unknown[] } } };
          };
        };
      }
    ).chrome!.notifications!.onClicked!.addListener as {
      mock: { calls: unknown[] };
    };
    expect(stub.mock.calls).toHaveLength(1);
  });
});
