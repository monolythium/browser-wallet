// Emergency recovery — standalone surface for the SLH-DSA backup / recovery
// editor, reached from the hamburger "Emergency recovery" entry. Reuses the
// SlhDsaBackupCard (the same editor that also renders on the Security page).

import { Icon } from "../Icon";
import { SlhDsaBackupCard } from "../components/SlhDsaBackupCard";

interface EmergencyRecoveryProps {
  onBack: () => void;
  vaultId: string;
  vaultAddress: string;
  chainIdHex: string;
}

export function EmergencyRecovery({
  onBack,
  vaultId,
  vaultAddress,
  chainIdHex,
}: EmergencyRecoveryProps) {
  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: "center" }}
        >
          Emergency recovery
        </div>
        <div style={{ width: 28 }} />
      </div>
      <div className="ext-body">
        <SlhDsaBackupCard
          vaultId={vaultId}
          vaultAddressLabel={vaultAddress}
          chainIdHex={chainIdHex}
        />
      </div>
    </>
  );
}
