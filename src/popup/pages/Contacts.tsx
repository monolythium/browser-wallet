// Round 7 TASK 5c — Contacts (address book) page.
//
// Renders the persisted contacts map (keyed by lowercase 0x address)
// as a list sorted most-recently-used-first. Empty state, add modal,
// inline rename, remove. Reads via useContacts (chrome.storage.onChanged
// subscribed) so any SW-side mutation (add / remove / rename, or the
// Round 7 TASK 6 post-send prompt) live-updates this list.

import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { Modal } from "../components/Modal";
import { CheckIcon, ClipboardIcon } from "../components/AddressLine";
import { useContacts } from "../hooks/useContacts";
import { addressToBech32m, bech32mToAddress } from "../../shared/bech32m";
import {
  bgContactsAdd,
  bgContactsRemove,
  bgContactsRename,
  type ContactRecord,
} from "../bg";

interface ContactsProps {
  onBack: () => void;
}

export function Contacts({ onBack }: ContactsProps) {
  const { contacts, loading } = useContacts();
  const [addOpen, setAddOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ContactRecord | null>(null);

  const sortedEntries = useMemo(() => {
    return Object.entries(contacts).sort(([, a], [, b]) => {
      // Most-recently-used first; never-used contacts fall back to
      // addedAt so the freshly-added record bumps to the top.
      return (b.lastUsedAt ?? b.addedAt) - (a.lastUsedAt ?? a.addedAt);
    });
  }, [contacts]);

  return (
    <>
      <div className="ext-top">
        <button className="ext-iconbtn" onClick={onBack} aria-label="Back">
          <Icon name="back" size={15} />
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          Contacts
        </div>
        <button
          className="ext-iconbtn"
          onClick={() => setAddOpen(true)}
          aria-label="Add contact"
          title="Add contact"
        >
          <Icon name="plus" size={15} />
        </button>
      </div>

      <div className="ext-body">
        {loading && (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              color: "var(--fg-300)",
              fontSize: 12,
            }}
          >
            Loading…
          </div>
        )}
        {!loading && sortedEntries.length === 0 && (
          <div
            style={{
              padding: "32px 20px",
              textAlign: "center",
              color: "var(--fg-300)",
              fontSize: 12.5,
              lineHeight: 1.55,
            }}
          >
            You haven&apos;t saved any contacts yet.
            <br />
            Add one to make sending faster.
            <div style={{ marginTop: 18 }}>
              <button
                onClick={() => setAddOpen(true)}
                style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: "1px solid var(--fg-700)",
                  background: "rgba(255,255,255,0.04)",
                  color: "var(--fg-100)",
                  fontFamily: "var(--f-sans)",
                  fontSize: 12,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Icon name="plus" size={12} />
                Add contact
              </button>
            </div>
          </div>
        )}
        {!loading && sortedEntries.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {sortedEntries.map(([key, c]) => (
              <ContactRow
                key={key}
                contact={c}
                onRename={() => setRenameTarget(c)}
                onRemove={async () => {
                  await bgContactsRemove(key);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <AddContactModal
        open={addOpen}
        existing={contacts}
        onClose={() => setAddOpen(false)}
      />
      <RenameContactModal
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
      />
    </>
  );
}

interface ContactRowProps {
  contact: ContactRecord;
  onRename: () => void;
  onRemove: () => void | Promise<void>;
}

function ContactRow({ contact, onRename, onRemove }: ContactRowProps) {
  const [copied, setCopied] = useState(false);
  const initial = (contact.name[0] ?? "?").toUpperCase();
  const handleCopy = () => {
    void navigator.clipboard.writeText(contact.bech32m).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="ext-card" style={{ padding: "10px 12px" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "var(--gold-bg, rgba(124,127,255,0.18))",
            color: "var(--gold, #7c7fff)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 600,
            fontSize: 13,
            flexShrink: 0,
          }}
          aria-hidden
        >
          {initial}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--fg-100)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {contact.name}
          </div>
          <div
            style={{
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-300)",
              letterSpacing: "-0.04em",
              overflow: "hidden",
              textOverflow: "clip",
              whiteSpace: "nowrap",
              marginTop: 2,
            }}
            title={contact.bech32m}
          >
            {contact.bech32m}
          </div>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          gap: 4,
          marginTop: 8,
          justifyContent: "flex-end",
        }}
      >
        <RowButton onClick={handleCopy} ariaLabel="Copy address">
          {copied ? <CheckIcon /> : <ClipboardIcon />}
        </RowButton>
        <RowButton onClick={onRename} ariaLabel="Rename contact">
          <Icon name="pen" size={12} />
        </RowButton>
        <RowButton onClick={onRemove} ariaLabel="Remove contact" danger>
          <Icon name="close" size={12} />
        </RowButton>
      </div>
    </div>
  );
}

function RowButton({
  children,
  onClick,
  ariaLabel,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void | Promise<void>;
  ariaLabel: string;
  danger?: boolean;
}) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    padding: 0,
    background: "transparent",
    border: "1px solid var(--fg-700)",
    borderRadius: 6,
    color: danger ? "var(--err, #ff8a9a)" : "var(--fg-300)",
    cursor: "pointer",
  };
  return (
    <button
      type="button"
      onClick={() => {
        void onClick();
      }}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={style}
    >
      {children}
    </button>
  );
}

interface AddContactModalProps {
  open: boolean;
  existing: Record<string, ContactRecord>;
  onClose: () => void;
  /** Optional seed values — used by the post-send "save recipient"
   *  flow in Round 7 TASK 6 to pre-fill the address and skip the
   *  address input. */
  seedAddress?: string;
  seedName?: string;
}

export function AddContactModal({
  open,
  existing,
  onClose,
  seedAddress,
  seedName,
}: AddContactModalProps) {
  const [addrInput, setAddrInput] = useState(seedAddress ?? "");
  const [nameInput, setNameInput] = useState(seedName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset inputs when the modal opens fresh.
  // (useEffect would re-fire on every re-render; keep it minimal.)

  const handleSubmit = async () => {
    setError(null);
    setSaving(true);
    try {
      const parsed = parseAddress(addrInput.trim());
      if (!parsed) {
        setError("Address doesn't look right. Expected mono1… or 0x…");
        return;
      }
      if (existing[parsed.addr0x.toLowerCase()]) {
        setError("This address is already in your contacts.");
        return;
      }
      const trimmedName = nameInput.trim();
      if (trimmedName.length === 0) {
        setError("Please give this contact a name.");
        return;
      }
      const r = await bgContactsAdd({
        address: parsed.addr0x,
        bech32m: parsed.bech32m,
        name: trimmedName,
      });
      if (!r.ok) {
        setError(r.reason ?? "Could not save contact.");
        return;
      }
      // Reset + close.
      setAddrInput("");
      setNameInput("");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add contact">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Field
          label="Name"
          value={nameInput}
          onChange={setNameInput}
          placeholder="e.g. Alice, Exchange, Cold storage"
          maxLength={64}
          autoFocus
        />
        {seedAddress ? (
          <div
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid var(--fg-700)",
              background: "rgba(0,0,0,0.2)",
              fontFamily: "var(--f-mono)",
              fontSize: 11,
              color: "var(--fg-200)",
              letterSpacing: "-0.03em",
              wordBreak: "break-all",
            }}
          >
            {seedAddress.startsWith("0x")
              ? addressToBech32m(seedAddress)
              : seedAddress}
          </div>
        ) : (
          <Field
            label="Address"
            value={addrInput}
            onChange={setAddrInput}
            placeholder="mono1… or 0x…"
            mono
          />
        )}
        {error && (
          <div
            style={{
              fontSize: 11,
              color: "var(--err, #ff8a9a)",
              padding: "4px 0",
            }}
          >
            {error}
          </div>
        )}
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 4,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={modalSecondary}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={saving}
            style={modalPrimary}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RenameContactModal({
  target,
  onClose,
}: {
  target: ContactRecord | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(target?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-seed when the target changes.
  // useEffect-free pattern: read from a closure key.
  if (target && name === "" && !error) {
    setName(target.name);
  }

  if (!target) return null;

  const submit = async () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name can't be empty.");
      return;
    }
    if (trimmed.length > 64) {
      setError("Name is too long (max 64 chars).");
      return;
    }
    setSaving(true);
    try {
      const r = await bgContactsRename(target.address, trimmed);
      if (!r.ok) {
        setError(r.reason ?? "Could not rename.");
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={true} onClose={onClose} title="Rename contact">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Field
          label="Name"
          value={name}
          onChange={(v) => {
            setName(v);
            setError(null);
          }}
          maxLength={64}
          autoFocus
        />
        {error && (
          <div style={{ fontSize: 11, color: "var(--err, #ff8a9a)" }}>{error}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={modalSecondary}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            style={modalPrimary}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  autoFocus,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontFamily: "var(--f-mono)",
          fontSize: 9.5,
          color: "var(--fg-400)",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        style={{
          padding: "8px 10px",
          borderRadius: 8,
          border: "1px solid var(--fg-700)",
          background: "rgba(0,0,0,0.2)",
          color: "var(--fg-100)",
          fontFamily: mono ? "var(--f-mono)" : "var(--f-sans)",
          fontSize: mono ? 11 : 12,
          letterSpacing: mono ? "-0.03em" : "normal",
        }}
      />
    </label>
  );
}

/** Accept either a 0x-hex address (40 hex chars) or a bech32m mono1
 *  string. Returns the canonical { addr0x, bech32m } pair so the
 *  caller can persist both forms without re-encoding. */
function parseAddress(
  input: string,
): { addr0x: string; bech32m: string } | null {
  if (!input) return null;
  const cleaned = input.trim();
  if (cleaned.startsWith("0x") || cleaned.startsWith("0X")) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(cleaned)) return null;
    return {
      addr0x: cleaned.toLowerCase(),
      bech32m: addressToBech32m(cleaned),
    };
  }
  if (cleaned.startsWith("mono")) {
    try {
      const addr0x = bech32mToAddress(cleaned);
      return { addr0x, bech32m: cleaned };
    } catch {
      return null;
    }
  }
  return null;
}

const modalPrimary: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--gold, #7c7fff)",
  background: "var(--gold-bg, rgba(124,127,255,0.18))",
  color: "var(--fg-100)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const modalSecondary: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid var(--fg-700)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--fg-200)",
  fontFamily: "var(--f-sans)",
  fontSize: 12,
  cursor: "pointer",
};
