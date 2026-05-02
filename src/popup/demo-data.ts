// Demo data ported from designs/src/ext-data.jsx.
// All numbers are mock values for the design surface — no chain reads here.
// TODO(monolythium-vision): replace with @monolythium/core-sdk reads once the SDK exists.

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

export interface Asset {
  sym: string;
  label: string;
  chain: string;
  amount: number | null;
  change: number | null;
  spark: number[] | null;
  attested: boolean;
  bridged?: boolean;
  opaque?: boolean;
}

export interface Dapp {
  id: string;
  name: string;
  url: string;
  icon: "M" | "S" | "C" | "G";
  verified: boolean;
  lastUsed: string;
  perms: string[];
}

export interface ActivityItem {
  id: string;
  when: string;
  dir: "in" | "out";
  amount: number | null;
  sym: string;
  who: string;
  attest: string;
  dac: number;
  round: string;
  algo: string;
  dapp?: string | null;
  bridged?: boolean;
  opaque?: boolean;
}

export interface PermSpec {
  k: string;
  desc: string;
  required: boolean;
}

export interface PendingConnect {
  dappId: string;
  origin: string;
  verified: boolean;
  perms: PermSpec[];
  accountToShare: string;
  phishingScore: number;
}

export interface PendingSign {
  dappId: string;
  origin: string;
  type: "swap" | "stake" | "vote" | "bridge" | "contract";
  summary: Record<string, unknown>;
  sim: { willReceive?: { amount: number; sym: string }; willPay?: { amount: number; sym: string }; net?: string; warnings: string[] } | null;
  fee: { amount: number; sym: string; denom: Denom };
  algo: Algo;
  decoded: { k: string; v: string }[];
  raw: string;
}

export interface PendingMessage {
  dappId: string;
  origin: string;
  type: "message";
  summary: { purpose: string; expires: string };
  humanPayload: {
    domain: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    statement: string;
  };
  algo: Algo;
  raw: string;
}

export const ACCOUNTS: Account[] = [
  { id: "acc1", label: "John Doe · ops", denom: "public", addr: "mono1:a9f2:john:ops", algo: "slhdsa", balance: 4128.42, stakable: 2628.42, staked: 1500, custody: "tpm", pinned: true },
  { id: "acc2", label: "John Doe · hidden", denom: "private", addr: "mvk:john:cold:8841", algo: "mldsa", balance: null, envelopes: 4, custody: "tpm" },
  { id: "acc3", label: "cold vault", denom: "public", addr: "mono1:77bd:cold:vault", algo: "slhdsa", balance: 18020.10, stakable: 18020.10, staked: 0, custody: "hw", pinned: false },
  { id: "acc4", label: "payroll burner", denom: "public", addr: "mono1:c9a3:burner:1", algo: "slhdsa", balance: 120.80, stakable: 120.80, staked: 0, custody: "sw", pinned: false },
];

export const ASSETS: Asset[] = [
  { sym: "LYTH", label: "Monolythium", chain: "lyth:mainnet", amount: 4128.42, change: 0.82, spark: [34, 35, 33, 36, 38, 37, 39, 40, 42, 41, 44, 45, 43, 46, 48, 47, 50, 52, 51, 54], attested: true },
  { sym: "LYTH-p", label: "Monolythium (private)", chain: "lyth:mainnet", amount: null, change: null, spark: null, attested: true, opaque: true },
  { sym: "wLYTH", label: "Wrapped LYTH", chain: "solana", amount: 420.11, change: 0.78, spark: [22, 23, 24, 23, 25, 26, 27, 28, 27, 29, 30, 31, 32, 33, 32, 34, 35, 36, 35, 37], attested: false, bridged: true },
  { sym: "LYTH", label: "LYTH · IBC", chain: "cosmos:hub", amount: 88.40, change: 0.30, spark: [40, 41, 40, 42, 43, 42, 44, 45, 44, 46, 47, 46, 48, 49, 48, 50, 51, 50, 52, 53], attested: false, bridged: true },
  { sym: "USDC", label: "USD Coin", chain: "solana", amount: 1240.00, change: -0.01, spark: [50, 50, 49, 50, 51, 50, 50, 50, 49, 50, 50, 51, 50, 50, 49, 50, 50, 50, 51, 50], attested: false, bridged: true },
];

export const DAPPS: Dapp[] = [
  { id: "monoscan", name: "Monoscan", url: "https://monoscan.xyz", icon: "M", verified: true, lastUsed: "now", perms: ["read:address", "read:activity"] },
  { id: "stake", name: "LYTH Stake", url: "https://stake.monolythium.xyz", icon: "S", verified: true, lastUsed: "2h ago", perms: ["read:address", "sign:stake"] },
  { id: "coinzen", name: "Coinzen DEX", url: "https://app.coinzen.io", icon: "C", verified: false, lastUsed: "5d ago", perms: ["read:address", "sign:tx", "sign:message"] },
  { id: "gov", name: "LYTH Gov", url: "https://gov.monolythium.xyz", icon: "G", verified: true, lastUsed: "yesterday", perms: ["read:address", "sign:message", "sign:vote"] },
];

export const ACTIVITY: ActivityItem[] = [
  { id: "t1", when: "just now", dir: "in", amount: 112.4, sym: "LYTH", who: "cluster C-014 · reward", attest: "attested", dac: 1.00, round: "2938·441", algo: "bls", dapp: null },
  { id: "t2", when: "4m ago", dir: "out", amount: 48.00, sym: "LYTH", who: "cypher payroll", attest: "attested", dac: 1.00, round: "2938·440", algo: "slhdsa", dapp: "coinzen" },
  { id: "t3", when: "1h ago", dir: "in", amount: 18.22, sym: "LYTH", who: "cluster C-003 · reward", attest: "attested", dac: 1.00, round: "2938·432", algo: "bls" },
  { id: "t4", when: "3h ago", dir: "out", amount: 1500, sym: "LYTH", who: "stake → C-021", attest: "attested", dac: 1.00, round: "2938·420", algo: "slhdsa", dapp: "stake" },
  { id: "t5", when: "yesterday", dir: "out", amount: null, sym: "LYTH-p", who: "mvk:mira:p2p", attest: "attested", dac: 1.00, round: "2937·880", algo: "mldsa", opaque: true },
  { id: "t6", when: "2d ago", dir: "out", amount: 90, sym: "LYTH", who: "bridge · Solana out", attest: "quorum-8/11", dac: 0.73, round: "2936·102", algo: "ed25519", bridged: true, dapp: "coinzen" },
  { id: "t7", when: "3d ago", dir: "in", amount: 520, sym: "LYTH", who: "coinzen withdrawal", attest: "attested", dac: 1.00, round: "2935·211", algo: "slhdsa", dapp: "coinzen" },
  { id: "t8", when: "4d ago", dir: "out", amount: 7.2, sym: "LYTH", who: "vote PROP-42 · abstain", attest: "attested", dac: 1.00, round: "2934·050", algo: "slhdsa", dapp: "gov" },
];

export const PENDING = {
  connect: {
    dappId: "coinzen",
    origin: "https://app.coinzen.io",
    verified: false,
    perms: [
      { k: "read:address", desc: "See your active address", required: true },
      { k: "read:activity", desc: "View your transaction history", required: false },
      { k: "sign:tx", desc: "Prompt to sign transfers when you act", required: true },
      { k: "sign:message", desc: "Prompt to sign typed messages (e.g. login)", required: false },
    ],
    accountToShare: "acc1",
    phishingScore: 0.08,
  } as PendingConnect,
  signSwap: {
    dappId: "coinzen",
    origin: "https://app.coinzen.io",
    type: "swap" as const,
    summary: { pay: { amount: 100, sym: "LYTH" }, receive: { amount: 1382.40, sym: "USDC" }, rate: "1 LYTH = 13.824 USDC", slippage: "0.5%", route: "coinzen pool #14" },
    sim: { willReceive: { amount: 1382.40, sym: "USDC" }, willPay: { amount: 100, sym: "LYTH" }, warnings: [] },
    fee: { amount: 0.0082, sym: "LYTH", denom: "public" as const },
    algo: "slhdsa" as const,
    decoded: [
      { k: "method", v: "swapExactIn(uint,uint,uint,address)" },
      { k: "from", v: "mono1:a9f2:john:ops" },
      { k: "pool", v: "cz14:LYTH-USDC" },
      { k: "amountIn", v: "100_000_000 (6-dp)" },
      { k: "minOut", v: "1_375_488_000 (6-dp)" },
      { k: "deadline", v: "round 2938·500 (~9m)" },
    ],
    raw: "0x8e2fd4b10000000000000000000000000000000000000000000000000000000005f5e10000000000000000000000000000000000000000000000000000000052068b3800000000000000000000000000000000000000000000000000000000000b7c0c0000000000000000000000003a12cfe0d8ff23cf4e62d1a8f2",
  } as PendingSign,
  signStake: {
    dappId: "stake",
    origin: "https://stake.monolythium.xyz",
    type: "stake" as const,
    summary: { action: "delegate", amount: { amount: 500, sym: "LYTH" }, target: "cluster C-021", apr: "8.64%", autoCompound: true, unlockEst: "epoch 2945 · ~13d" },
    sim: { willReceive: { amount: 500, sym: "stkLYTH (voucher)" }, willPay: { amount: 500, sym: "LYTH" }, net: "neutral · custody handoff", warnings: [] },
    fee: { amount: 0.0082, sym: "LYTH", denom: "public" as const },
    algo: "slhdsa" as const,
    decoded: [
      { k: "method", v: "delegate(bytes32,uint,bool)" },
      { k: "cluster", v: "0xC021 · diversity=0.31" },
      { k: "amount", v: "500_000_000 (6-dp)" },
      { k: "autoCmpd", v: "true" },
      { k: "unlockRule", v: "epoch+7 unbond · slash=clusterBonded" },
    ],
    raw: "0x21c5e9d300000000000000000000000000000000000000000000000000000000c0210000000000000000000000000000000000000000000000000000001dcd65000000000000000000000000000000000000000000000000000000000000000001",
  } as PendingSign,
  signVote: {
    dappId: "gov",
    origin: "https://gov.monolythium.xyz",
    type: "vote" as const,
    summary: { proposal: "PROP-43", title: "Adopt ML-DSA-65 as non-optional dual signature post-2027", choice: "YES", weight: "1,500 LYTH (staked @ C-003)" },
    sim: null,
    fee: { amount: 0.0082, sym: "LYTH", denom: "public" as const },
    algo: "slhdsa" as const,
    decoded: [
      { k: "method", v: "castVote(bytes32,uint8)" },
      { k: "proposal", v: "0xPROP-43" },
      { k: "choice", v: "1 = YES" },
    ],
    raw: "0x3f4b7b8400000000000000000000000000000000000000000000000000002b0000000000000000000000000000000000000000000000000000000000000001",
  } as PendingSign,
  signBridge: {
    dappId: "coinzen",
    origin: "https://bridge.monolythium.xyz",
    type: "bridge" as const,
    summary: { action: "bridge out", amount: { amount: 90, sym: "LYTH" }, from: "Monolythium mainnet", to: "Solana", receive: { amount: 90, sym: "wLYTH" }, rate: "1:1 canonical", relays: "11/14 live", etaMin: 3 },
    sim: { willReceive: { amount: 90, sym: "wLYTH (Solana)" }, willPay: { amount: 90, sym: "LYTH" }, net: "−0.08 LYTH · relay fee", warnings: ["Bridge operates on multi-relay quorum · not chain-native"] },
    fee: { amount: 0.0082, sym: "LYTH", denom: "public" as const },
    algo: "slhdsa" as const,
    decoded: [
      { k: "method", v: "lockAndEmit(bytes,uint)" },
      { k: "recipient", v: "sol:nAYe…3mQx" },
      { k: "amount", v: "90_000_000" },
    ],
    raw: "0x9eac01b900000000000000000000000000000000000000000000000000005614",
  } as PendingSign,
  signContract: {
    dappId: "coinzen",
    origin: "https://app.coinzen.io",
    type: "contract" as const,
    summary: { action: "Approve unlimited spend", token: "LYTH", spender: "cz14:router", risk: "high" },
    sim: { net: "No value transferred — grants spend rights", warnings: ["Unlimited allowance — consider a bounded cap", "Spender not in LYTH verified registry"] },
    fee: { amount: 0.0082, sym: "LYTH", denom: "public" as const },
    algo: "slhdsa" as const,
    decoded: [
      { k: "method", v: "approve(address,uint)" },
      { k: "spender", v: "cz14:router · 0x3a12…cfe0" },
      { k: "amount", v: "2^256 − 1  (unlimited)" },
    ],
    raw: "0x095ea7b30000000000000000000000003a12cfe0d8ff23cf4e62d1a8f2ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  } as PendingSign,
  signMessage: {
    dappId: "gov",
    origin: "https://gov.monolythium.xyz",
    type: "message" as const,
    summary: { purpose: "Sign in to LYTH Gov", expires: "10 minutes" },
    humanPayload: {
      domain: "gov.monolythium.xyz",
      nonce: "b7f2…99ae",
      issuedAt: "2026-04-21T14:02:00Z",
      expiresAt: "2026-04-21T14:12:00Z",
      statement: "I agree to the LYTH Gov terms · no value transfer · account binding only.",
    },
    algo: "slhdsa" as const,
    raw: "lyth:msg:0xb7f29f…",
  } as PendingMessage,
};

export const NODE = {
  handle: "node-03",
  round: "2938·441",
  dacCoverage: 1.0,
  pcr: "9f2e:4b81:3a07",
  talos: "v1.9.4",
  attested: true,
  staleness: "2m",
};
