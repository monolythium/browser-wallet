export interface WalletTokenBalanceMrcIdentity {
  standard: string;
  assetId: string;
  tokenId?: string;
}

export type WalletMrcHolderStandard = "mrc721" | "mrc1155" | "mrc4626";

export interface WalletMrcHolder {
  rank: number;
  address: string;
  balance: string;
  updatedAtBlock: number;
}

export interface WalletMrcHoldersResponse {
  schemaVersion: number;
  standard: WalletMrcHolderStandard;
  assetId: string;
  tokenId: string | null;
  limit: number;
  holders: WalletMrcHolder[];
}

export interface WalletTokenBalance {
  tokenId: string;
  balance: string;
  updatedAtBlock: number;
  mrc?: WalletTokenBalanceMrcIdentity;
  mrcHolders?: WalletMrcHoldersResponse;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const proto = Object.getPrototypeOf(input);
  return proto === Object.prototype || proto === null;
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

function normalizeWalletMrcHolderStandard(
  input: unknown,
): WalletMrcHolderStandard | null {
  if (input !== "mrc721" && input !== "mrc1155" && input !== "mrc4626") {
    return null;
  }
  return input;
}

function validateBlockHeight(input: unknown): number | null {
  if (isFiniteNum(input) && Number.isSafeInteger(input) && input >= 0) {
    return input;
  }
  if (typeof input === "bigint" && input >= 0n && input <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(input);
  }
  if (typeof input === "string" && /^[0-9]+$/.test(input)) {
    const parsed = Number(input);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function validateWalletMrcHolder(input: unknown): WalletMrcHolder | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (!isFiniteNum(r.rank) || !Number.isSafeInteger(r.rank) || r.rank < 1) {
    return null;
  }
  if (typeof r.address !== "string" || r.address.length === 0) return null;
  if (typeof r.balance !== "string") return null;
  const updatedAtBlock = validateBlockHeight(r.updatedAtBlock);
  if (updatedAtBlock === null) return null;
  return {
    rank: r.rank,
    address: r.address,
    balance: r.balance,
    updatedAtBlock,
  };
}

export function validateWalletMrcHoldersResponse(
  input: unknown,
): WalletMrcHoldersResponse | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (
    !isFiniteNum(r.schemaVersion) ||
    !Number.isSafeInteger(r.schemaVersion) ||
    r.schemaVersion < 1
  ) {
    return null;
  }
  const standard = normalizeWalletMrcHolderStandard(r.standard);
  if (standard === null) return null;
  if (typeof r.assetId !== "string" || r.assetId.length === 0) return null;
  let tokenId: string | null;
  if (standard === "mrc4626") {
    if (r.tokenId !== null && r.tokenId !== undefined) return null;
    tokenId = null;
  } else {
    if (typeof r.tokenId !== "string" || r.tokenId.length === 0) return null;
    tokenId = r.tokenId;
  }
  if (!isFiniteNum(r.limit) || !Number.isSafeInteger(r.limit) || r.limit < 1) {
    return null;
  }
  if (!Array.isArray(r.holders)) return null;

  const holders: WalletMrcHolder[] = [];
  for (const holder of r.holders.slice(0, Math.trunc(r.limit))) {
    const row = validateWalletMrcHolder(holder);
    if (row !== null) holders.push(row);
  }

  return {
    schemaVersion: r.schemaVersion,
    standard,
    assetId: r.assetId,
    tokenId,
    limit: Math.trunc(r.limit),
    holders,
  };
}

export function validateWalletTokenBalance(
  input: unknown,
): WalletTokenBalance | null {
  if (!isPlainRecord(input)) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.tokenId !== "string") return null;
  if (typeof r.balance !== "string") return null;
  if (!isFiniteNum(r.updatedAtBlock)) return null;

  const out: WalletTokenBalance = {
    tokenId: r.tokenId,
    balance: r.balance,
    updatedAtBlock: r.updatedAtBlock,
  };

  if (r.mrc !== undefined && r.mrc !== null) {
    const mrc = validateWalletTokenBalanceMrcIdentity(r.mrc);
    if (mrc === null) return null;
    out.mrc = mrc;
  }

  if (r.mrcHolders !== undefined && r.mrcHolders !== null) {
    const mrcHolders = validateWalletMrcHoldersResponse(r.mrcHolders);
    if (mrcHolders !== null) out.mrcHolders = mrcHolders;
  }

  return out;
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
