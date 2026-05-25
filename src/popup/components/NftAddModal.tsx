// Phase 5 Commit 6 — NftAddModal. Ported from the inline `AddNftView`
// inside `browser-wallet-old/src/popup/components/NftTab.tsx` (lines
// 565-721 of the 721-LOC reference). Repackaged as a Modal for the
// new wallet's modal-driven add flow (matches VaultAddModal from
// Commit 4).
//
// Two-step flow:
//   1. Form — contract address + token id input. Submit triggers a
//      preview call.
//   2. Preview — `detectStandard` (ERC-721 vs ERC-1155 via
//      supportsInterface) → `contractName` + `contractSymbol` →
//      ownership precheck. ERC-721 calls ownerOf; ERC-1155 calls
//      balanceOf(owner, id). On standard mismatch we surface a
//      clear error rather than blindly pinning. On ownership
//      mismatch / zero balance we show a warning that lets the
//      user pin anyway (matches the prompt's locked precheck spec).
//
// All chain calls flow through the EthCaller adapter the parent
// passes in — production callers wire it to bgEthCall via
// `nftEthCaller.ts` so the popup never opens its own RPC socket.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { typedBech32ToAddress } from "@monolythium/core-sdk";

import { Icon } from "../Icon";
import { Modal } from "./Modal";
import {
  contractName,
  contractSymbol,
  erc1155BalanceOf,
  erc721OwnerOf,
  pinNft,
  supportsErc1155,
  supportsErc721,
  type EthCaller,
} from "../../lib/nft-client";

type Standard = "erc721" | "erc1155";

export const NFT_CONTRACT_ADDRESS_PLACEHOLDER =
  "monoc1yg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zr6jfvd";

export type ParsedNftContractAddress =
  | { ok: true; typed: string; hex: string }
  | { ok: false; reason: string };

export function parseNftContractAddressInput(input: string): ParsedNftContractAddress {
  const value = input.trim();
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return {
      ok: false,
      reason: "NFT contract address raw 0x addresses are retired; use a typed monoc1 address",
    };
  }
  try {
    const parsed = typedBech32ToAddress(value, "contract");
    return { ok: true, typed: parsed.address, hex: parsed.hex.toLowerCase() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `NFT contract address must be a typed monoc1 address: ${message}`,
    };
  }
}

interface PreviewState {
  standard: Standard;
  collectionName: string;
  collectionSymbol: string;
  /** ERC-721 owner address (`0x` lowercase) or undefined for 1155. */
  owner?: string;
  /** ERC-1155 balance for the owner (>= 0n); undefined for 721. */
  balance?: bigint;
}

export interface NftAddModalProps {
  open: boolean;
  /** EthCaller wired against the active chain — see
   *  `nftEthCaller.ts` for the production adapter. */
  caller: EthCaller;
  /** Sprintnet chain id passed straight into `pinNft`. */
  chainId: number;
  /** Active vault EVM address (`0x` 40-hex). Used for the ownership
   *  precheck. Pass null to skip the precheck (the user proceeds
   *  blind). */
  ownerAddress: string | null;
  onClose: () => void;
  onAdded: (contractAddress: string, tokenId: string) => void;
}

export function NftAddModal({
  open,
  caller,
  chainId,
  ownerAddress,
  onClose,
  onAdded,
}: NftAddModalProps) {
  if (!open) return null;
  return (
    <Modal open={open} onClose={onClose} title="Add NFT by contract address">
      <NftAddBody
        caller={caller}
        chainId={chainId}
        ownerAddress={ownerAddress}
        onClose={onClose}
        onAdded={onAdded}
      />
    </Modal>
  );
}

interface NftAddBodyProps {
  caller: EthCaller;
  chainId: number;
  ownerAddress: string | null;
  onClose: () => void;
  onAdded: (contractAddress: string, tokenId: string) => void;
}

function NftAddBody({
  caller,
  chainId,
  ownerAddress,
  onClose,
  onAdded,
}: NftAddBodyProps) {
  const [contractInput, setContractInput] = useState("");
  const [tokenIdInput, setTokenIdInput] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  // Reset error/preview whenever the user edits the inputs.
  useEffect(() => {
    if (error) setError(null);
    if (preview) setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractInput, tokenIdInput]);

  const trimmedContract = contractInput.trim();
  const trimmedTokenId = tokenIdInput.trim().replace(/^#/, "");
  const parsedContract = parseNftContractAddressInput(trimmedContract);
  const contractInputError =
    trimmedContract.length > 0 && !parsedContract.ok ? parsedContract.reason : null;
  let parsedTokenId: bigint | null = null;
  if (trimmedTokenId.length > 0) {
    try {
      parsedTokenId = BigInt(trimmedTokenId);
    } catch {
      parsedTokenId = null;
    }
  }
  const inputsValid =
    parsedContract.ok && parsedTokenId !== null && parsedTokenId >= 0n;

  const ownsOk =
    preview === null
      ? false
      : preview.standard === "erc721"
        ? !!ownerAddress &&
          !!preview.owner &&
          preview.owner.toLowerCase() === ownerAddress.toLowerCase()
        : preview.balance !== undefined && preview.balance > 0n;

  const handleVerify = async () => {
    const contractForVerify = parsedContract;
    if (verifying || !inputsValid || parsedTokenId === null) return;
    if (!contractForVerify.ok) {
      setError(contractForVerify.reason);
      return;
    }
    setVerifying(true);
    setError(null);
    setPreview(null);
    try {
      const addr = contractForVerify.hex;
      // Detect standard. Run both probes in parallel; if both report
      // false, fall back to ERC-721 since most metadata-bearing
      // contracts implement it as the default.
      const [is721, is1155] = await Promise.all([
        supportsErc721(caller, addr),
        supportsErc1155(caller, addr),
      ]);
      let standard: Standard;
      if (is1155 && !is721) standard = "erc1155";
      else standard = "erc721";

      // Pull collection metadata. Either may revert on minimalist
      // contracts; defaults preserve the reference's UX.
      let collectionName = "Unknown collection";
      let collectionSymbol = "NFT";
      let contractResponds = false;
      try {
        collectionName = await contractName(caller, addr);
        contractResponds = true;
      } catch {
        /* name() reverted */
      }
      try {
        collectionSymbol = await contractSymbol(caller, addr);
      } catch {
        /* symbol() reverted */
      }

      // Ownership precheck.
      if (standard === "erc721") {
        let owner: string;
        try {
          owner = await erc721OwnerOf(caller, addr, parsedTokenId);
        } catch {
          setError(
            !contractResponds
              ? "This address doesn't look like an MRC-721 contract on the active chain."
              : `Token #${parsedTokenId.toString()} doesn't exist on ${collectionName}.`,
          );
          setVerifying(false);
          return;
        }
        setPreview({
          standard,
          collectionName,
          collectionSymbol,
          owner: owner.toLowerCase(),
        });
      } else {
        if (!ownerAddress) {
          // Without an owner we can't even probe balance — show
          // preview without a precheck so the user can pin anyway.
          setPreview({
            standard,
            collectionName,
            collectionSymbol,
          });
        } else {
          let balance: bigint;
          try {
            balance = await erc1155BalanceOf(
              caller,
              addr,
              ownerAddress,
              parsedTokenId,
            );
          } catch {
            setError(
              `Couldn't read balance for #${parsedTokenId.toString()} on ${collectionName}.`,
            );
            setVerifying(false);
            return;
          }
          setPreview({
            standard,
            collectionName,
            collectionSymbol,
            balance,
          });
        }
      }
    } catch (e) {
      setError((e as Error).message ?? "Verification failed.");
    } finally {
      setVerifying(false);
    }
  };

  const handlePin = async () => {
    const contractForPin = parseNftContractAddressInput(contractInput);
    if (pinning || !preview || parsedTokenId === null) return;
    if (!contractForPin.ok) {
      setError(contractForPin.reason);
      return;
    }
    setPinning(true);
    setError(null);
    try {
      const addrLc = contractForPin.hex;
      const tokenIdStr = parsedTokenId.toString();
      await pinNft({ chainId, address: addrLc, tokenId: tokenIdStr });
      onAdded(addrLc, tokenIdStr);
    } catch (e) {
      setError((e as Error).message ?? "Could not pin NFT.");
    } finally {
      setPinning(false);
    }
  };

  return (
    <div style={colStyle}>
      <div style={hintStyle}>
        Pin any MRC-721 or MRC-1155 token by its contract address and
        token id. Sprintnet&apos;s indexer is currently disabled cluster-
        wide, so discovery isn&apos;t automatic — pinning is the way in.
        (ERC-shaped contracts are read via the EVM compat path until
        operators ship the native lyth_mrc* RPC; whitepaper §22.5.)
      </div>

      <div style={fieldGroupStyle}>
        <FieldLabel>Contract address</FieldLabel>
        <input
          type="text"
          value={contractInput}
          onChange={(e) => setContractInput(e.target.value)}
          placeholder={NFT_CONTRACT_ADDRESS_PLACEHOLDER}
          disabled={verifying || pinning}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          style={inputStyle}
        />
      </div>
      {contractInputError && <ErrorLine>{contractInputError}</ErrorLine>}

      <div style={fieldGroupStyle}>
        <FieldLabel>Token ID</FieldLabel>
        <input
          type="text"
          value={tokenIdInput}
          onChange={(e) => setTokenIdInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleVerify();
          }}
          placeholder="42"
          disabled={verifying || pinning}
          spellCheck={false}
          style={inputStyle}
        />
      </div>

      {error && <ErrorLine>{error}</ErrorLine>}

      {preview && (
        <div
          style={{
            border: "1px solid var(--glass-stroke)",
            borderRadius: 10,
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: "rgba(255,255,255,0.03)",
          }}
        >
          <PreviewRow label="Collection" value={preview.collectionName} />
          <PreviewRow label="Symbol" value={preview.collectionSymbol} />
          <PreviewRow
            label="Standard"
            value={preview.standard === "erc1155" ? "MRC-1155" : "MRC-721"}
          />
          <PreviewRow
            label="Token ID"
            value={`#${parsedTokenId?.toString() ?? ""}`}
          />
          {preview.standard === "erc721" && preview.owner && (
            <PreviewRow
              label="Owner"
              value={`${preview.owner.slice(0, 8)}…${preview.owner.slice(-6)}`}
            />
          )}
          {preview.standard === "erc1155" && preview.balance !== undefined && (
            <PreviewRow label="Your balance" value={preview.balance.toString()} />
          )}

          {!ownsOk && ownerAddress && (
            <div
              style={{
                marginTop: 4,
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(242,180,65,0.08)",
                border: "1px solid rgba(242,180,65,0.4)",
                color: "var(--fg-100)",
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              You don&apos;t currently own this NFT
              {preview.standard === "erc721" && preview.owner
                ? ` (owner: ${preview.owner.slice(0, 8)}…${preview.owner.slice(-6)})`
                : ""}
              . Pin anyway?
            </div>
          )}
        </div>
      )}

      <FooterRow>
        <button
          type="button"
          onClick={onClose}
          style={btnSecondary}
          disabled={verifying || pinning}
        >
          Cancel
        </button>
        {preview === null ? (
          <button
            type="button"
            onClick={() => void handleVerify()}
            disabled={!inputsValid || verifying}
            style={
              !inputsValid || verifying
                ? { ...btnPrimary, ...btnDisabled }
                : btnPrimary
            }
          >
            {verifying ? "Verifying…" : "Verify"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handlePin()}
            disabled={pinning}
            style={pinning ? { ...btnPrimary, ...btnDisabled } : btnPrimary}
          >
            {pinning ? "Pinning…" : ownsOk ? "Pin NFT" : "Pin anyway"}
          </button>
        )}
      </FooterRow>
    </div>
  );
}

// ---- Tiny presentational helpers (kept inline; popup convention) ----

interface PreviewRowProps {
  label: string;
  value: string;
}

function PreviewRow({ label, value }: PreviewRowProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontFamily: "var(--f-mono)",
          color: "var(--fg-400)",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 11.5,
          color: "var(--fg-100)",
          fontFamily: "var(--f-mono)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 10,
        color: "var(--fg-400)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--f-mono)",
        fontSize: 11,
        color: "var(--err)",
        lineHeight: 1.4,
        display: "flex",
        gap: 6,
        alignItems: "flex-start",
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>
        <Icon name="warn" size={11} />
      </span>
      <span>{children}</span>
    </div>
  );
}

function FooterRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 4,
      }}
    >
      {children}
    </div>
  );
}

const colStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const hintStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-300)",
  lineHeight: 1.5,
};

const fieldGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const inputStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(0,0,0,0.3)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-mono)",
  fontSize: 12,
  outline: "none",
};

const btnPrimary: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid rgba(124,127,255,0.6)",
  background: "rgba(124,127,255,0.18)",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondary: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "transparent",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 11.5,
  cursor: "pointer",
};

const btnDisabled: CSSProperties = {
  background: "rgba(124,127,255,0.06)",
  color: "var(--fg-500)",
  cursor: "not-allowed",
};
