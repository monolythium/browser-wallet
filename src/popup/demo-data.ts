// Demo data ported from designs/src/ext-data.jsx.
// All numbers are mock values for the design surface — no chain reads here.
// Public account fixtures keep raw 20-byte address bytes here because the
// render layer derives canonical mono1 display via bech32mDisplay.

export type Denom = "public" | "private";
export type Custody = "tpm" | "passkey" | "hw" | "sw";
export type Algo = "slhdsa" | "mldsa";

export interface Account {
  id: string;
  label: string;
  denom: Denom;
  addr: string;
  algo: Algo;
  balance: number | null;
  stakable?: number;
  staked?: number;
  envelopes?: number;
  custody: Custody;
  pinned?: boolean;
}

export interface Dapp {
  id: string;
  name: string;
  url: string;
  /** Color class for the avatar — maps to `.ext-dapp .glyph.{icon}` CSS. */
  icon: "M" | "S" | "C" | "G";
  /** Displayed character on the avatar. Defaults to `icon` when unset.
   * Lets a dApp wear a color class without locking the visible letter
   * to it (e.g. MonoHub uses the `C` purple class but displays "M"). */
  glyph?: string;
  verified: boolean;
  lastUsed: string;
  perms: string[];
}

export const ACCOUNTS: Account[] = [
  { id: "acc1", label: "John Doe · ops", denom: "public", addr: "0xa9f2000000000000000000000000000000000001", algo: "slhdsa", balance: 4128.42, stakable: 2628.42, staked: 1500, custody: "tpm", pinned: true },
  { id: "acc2", label: "John Doe · hidden", denom: "private", addr: "mvk:john:cold:8841", algo: "mldsa", balance: null, envelopes: 4, custody: "tpm" },
  { id: "acc3", label: "cold vault", denom: "public", addr: "0x77bd000000000000000000000000000000000003", algo: "slhdsa", balance: 18020.10, stakable: 18020.10, staked: 0, custody: "hw", pinned: false },
  { id: "acc4", label: "payroll burner", denom: "public", addr: "0xc9a3000000000000000000000000000000000004", algo: "slhdsa", balance: 120.80, stakable: 120.80, staked: 0, custody: "sw", pinned: false },
];

export const DAPPS: Dapp[] = [
  { id: "monoscan", name: "Monoscan", url: "https://monoscan.xyz", icon: "M", verified: true, lastUsed: "now", perms: ["read:address", "read:activity"] },
  { id: "stake", name: "LYTH Stake", url: "https://stake.monolythium.xyz", icon: "S", verified: true, lastUsed: "2h ago", perms: ["read:address", "sign:stake"] },
  { id: "monohub", name: "MonoHub", url: "https://app.monohub.xyz", icon: "C", glyph: "M", verified: false, lastUsed: "5d ago", perms: ["read:address", "sign:tx", "sign:message"] },
];

export const NODE = {
  handle: "node-03",
  round: "2938·441",
  dacCoverage: 1.0,
  pcr: "9f2e:4b81:3a07",
  talos: "v1.9.4",
  attested: true,
  staleness: "2m",
};
