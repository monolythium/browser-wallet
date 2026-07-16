import type {
  AuthenticationApprovalSnapshot,
} from "./approvals.js";
import type { WalletAuthRequestV1 } from "../shared/wallet-auth.js";

/**
 * Bind the account actually rendered by the approval popup to a service-worker
 * state snapshot captured at the approval click. All values in `state` come
 * from privileged wallet state, never popup payloads.
 */
export function bindWalletAuthApprovalSnapshot(
  challenge: WalletAuthRequestV1,
  displayedAddress: unknown,
  state: AuthenticationApprovalSnapshot | null,
): AuthenticationApprovalSnapshot | null {
  if (
    state === null ||
    displayedAddress !== state.address ||
    challenge.chainId !== state.chainId ||
    challenge.genesisHash !== state.genesisHash
  ) {
    return null;
  }
  return { ...state };
}

export function walletAuthApprovalStateMatches(
  approved: AuthenticationApprovalSnapshot,
  current: AuthenticationApprovalSnapshot | null,
): boolean {
  return (
    current !== null &&
    approved.vaultId === current.vaultId &&
    approved.address === current.address &&
    approved.chainId === current.chainId &&
    approved.genesisHash === current.genesisHash
  );
}
