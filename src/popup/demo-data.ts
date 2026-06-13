// Account shape types for the popup render layer.
//
// This file once also exported mock `ACCOUNTS` / `NODE` design fixtures
// (John Doe / 4,128.42 LYTH / sentinel 0x… addresses). Those were REMOVED:
// when the real account or chain was slow/unreachable, the popup fell back to
// the fixture and displayed a FABRICATED balance + address as if it were the
// user's wallet. The wallet must never show invented values — an unresolved
// account renders a neutral loading/empty state instead (App seeds `acc` with
// a blank, balance:null placeholder; the address line shows "—" and the hero
// shows "0.00" until the real account/balance resolves). Only the type
// definitions remain here.

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
