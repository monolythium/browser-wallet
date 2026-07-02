import { describe, expect, it } from "vitest";
import {
  SENT_ADDRESSES_CAP,
  sentAddressesKey,
  parseSentEntries,
  addSentEntry,
  canonicalSentAddrMessage,
  type SentAddrEntry,
} from "./sent-addresses.js";

describe("sent-addresses store key", () => {
  it("builds a per-(vault, chain) key", () => {
    expect(sentAddressesKey("0xabc", "0x10f2c")).toBe(
      "mono.sent-addrs.0xabc.0x10f2c",
    );
  });
});

describe("parseSentEntries — tolerant, fail-safe to empty", () => {
  it("returns [] for the legacy {addrs} shape (untrusted → warning fires)", () => {
    expect(parseSentEntries({ addrs: ["0xa", "0xb"] })).toEqual([]);
  });

  it("returns [] for null / non-object / missing or wrong version / bad entries", () => {
    expect(parseSentEntries(null)).toEqual([]);
    expect(parseSentEntries("nope")).toEqual([]);
    expect(parseSentEntries({ entries: [{ a: "0xa", t: "ff" }] })).toEqual([]); // no v
    expect(parseSentEntries({ v: 2, entries: [{ a: "0xa", t: "ff" }] })).toEqual([]);
    expect(parseSentEntries({ v: 1, entries: "nope" })).toEqual([]);
  });

  it("parses a valid {v:1, entries} and filters structurally-bad entries", () => {
    const raw = {
      v: 1,
      entries: [
        { a: "0xa", t: "ff" },
        { a: "0xb", t: "" }, // empty tag → dropped
        { a: "", t: "ee" }, // empty addr → dropped
        { a: 1, t: "dd" }, // non-string addr → dropped
        null, // non-object → dropped
        { a: "0xc", t: "cc" },
      ],
    };
    expect(parseSentEntries(raw)).toEqual([
      { a: "0xa", t: "ff" },
      { a: "0xc", t: "cc" },
    ]);
  });
});

describe("addSentEntry — newest-first, dedup-by-addr, capped", () => {
  it("prepends a new entry (lowercased addr)", () => {
    expect(addSentEntry([], "0xAbC", "ff")).toEqual([{ a: "0xabc", t: "ff" }]);
  });

  it("dedups by addr — replaces the tag and moves it to the front", () => {
    const start: SentAddrEntry[] = [
      { a: "0xold", t: "11" },
      { a: "0xabc", t: "22" },
    ];
    expect(addSentEntry(start, "0xABC", "99")).toEqual([
      { a: "0xabc", t: "99" },
      { a: "0xold", t: "11" },
    ]);
  });

  it("caps at SENT_ADDRESSES_CAP, newest first", () => {
    const big: SentAddrEntry[] = Array.from(
      { length: SENT_ADDRESSES_CAP },
      (_, i) => ({ a: `0x${i}`, t: "ff" }),
    );
    const next = addSentEntry(big, "0xbrandnew", "ee");
    expect(next).toHaveLength(SENT_ADDRESSES_CAP);
    expect(next[0]).toEqual({ a: "0xbrandnew", t: "ee" });
  });
});

describe("canonicalSentAddrMessage — deterministic, lowercased, bound", () => {
  it("lowercases all three fields and joins with the unit separator", () => {
    expect(canonicalSentAddrMessage("0xVAULT", "0xAA", "0xRECIP")).toBe(
      "mono-sent-addr.v1\x1f0xvault\x1f0xaa\x1f0xrecip",
    );
  });

  it("is deterministic and differs on each component (cross-binding)", () => {
    const base = canonicalSentAddrMessage("0xv", "0x1", "0xr");
    expect(canonicalSentAddrMessage("0xv", "0x1", "0xr")).toBe(base);
    expect(canonicalSentAddrMessage("0xv2", "0x1", "0xr")).not.toBe(base); // vault
    expect(canonicalSentAddrMessage("0xv", "0x2", "0xr")).not.toBe(base); // chain
    expect(canonicalSentAddrMessage("0xv", "0x1", "0xr2")).not.toBe(base); // recipient
  });
});
