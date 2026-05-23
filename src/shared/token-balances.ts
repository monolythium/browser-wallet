export interface WalletTokenBalanceMrcIdentity {
  standard: string;
  assetId: string;
  tokenId?: string;
}

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
  mrc?: WalletTokenBalanceMrcIdentity;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateWalletTokenBalanceMrcIdentity(
  input: unknown,
): WalletTokenBalanceMrcIdentity | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const r = input as Record<string, unknown>;
  if (typeof r.standard !== "string" || r.standard.length === 0) return null;
  if (typeof r.assetId !== "string" || r.assetId.length === 0) return null;
  if (
    r.tokenId !== undefined &&
    r.tokenId !== null &&
    typeof r.tokenId !== "string"
  ) {
    return null;
  }
  return {
    standard: r.standard,
    assetId: r.assetId,
    ...(typeof r.tokenId === "string" ? { tokenId: r.tokenId } : {}),
  };
}

export function validateWalletTokenBalance(
  input: unknown,
): WalletTokenBalance | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const r = input as Record<string, unknown>;
  if (typeof r.tokenId !== "string") return null;
  if (typeof r.balance !== "string") return null;
  if (!isFiniteNum(r.updatedAtBlock)) return null;

  const base = {
    tokenId: r.tokenId,
    balance: r.balance,
    updatedAtBlock: r.updatedAtBlock,
  };
  if (r.mrc === undefined || r.mrc === null) return base;

  const mrc = validateWalletTokenBalanceMrcIdentity(r.mrc);
  if (mrc === null) return null;
  return { ...base, mrc };
}

export function validateWalletTokenBalanceList(
  input: unknown[],
): WalletTokenBalance[] {
  const out: WalletTokenBalance[] = [];
  for (const raw of input) {
    const row = validateWalletTokenBalance(raw);
    if (row !== null) out.push(row);
  }
  return out;
}
