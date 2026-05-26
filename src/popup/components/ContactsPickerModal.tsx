// Round 13 TASK 2 — Contacts picker for the Send recipient field.
//
// Modal shown when the user taps the address-book icon next to the
// Paste button on Send. Lists saved contacts (Round 7 infrastructure)
// sorted MRU; clicking a row fills the recipient and closes the
// modal. Search input filters by name OR bech32m address.
//
// No new state lives here — the contacts come from the existing
// useContacts hook so the list stays reactive to chrome.storage
// updates (e.g. the user added a contact in another tab while the
// picker was open).

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { useContacts } from "../hooks/useContacts";
import type { ContactRecord } from "../bg";
import { Icon } from "../Icon";

interface ContactsPickerModalProps {
  open: boolean;
  onSelect: (contact: ContactRecord) => void;
  onClose: () => void;
}

export function ContactsPickerModal({
  open,
  onSelect,
  onClose,
}: ContactsPickerModalProps) {
  const { contacts, loading } = useContacts();
  const [search, setSearch] = useState("");

  const entries = useMemo(() => {
    const all = Object.values(contacts);
    const q = search.trim().toLowerCase();
    const filtered = q
      ? all.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.bech32m.toLowerCase().includes(q) ||
            c.address.toLowerCase().includes(q),
        )
      : all;
    // MRU sort: lastUsedAt (falls back to addedAt) descending.
    return filtered.sort(
      (a, b) =>
        (b.lastUsedAt ?? b.addedAt) - (a.lastUsedAt ?? a.addedAt),
    );
  }, [contacts, search]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <>
          <Icon name="book" size={13} />
          <span>Choose contact</span>
        </>
      }
    >
      <input
        type="text"
        autoFocus
        placeholder="Search by name or address"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        style={{
          width: "100%",
          padding: "9px 12px",
          borderRadius: 8,
          background: "rgba(0,0,0,0.3)",
          border: "1px solid var(--fg-700)",
          color: "var(--fg-100)",
          fontFamily: "var(--f-sans)",
          fontSize: 12.5,
          outline: "none",
          boxSizing: "border-box",
        }}
      />

      {loading ? (
        <div
          style={{
            padding: "24px 8px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--fg-400)",
            fontFamily: "var(--f-mono)",
          }}
        >
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <div
          style={{
            padding: "24px 12px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--fg-300)",
            lineHeight: 1.5,
          }}
        >
          {search.trim().length > 0 ? (
            <>
              No contacts match{" "}
              <span style={{ color: "var(--fg-100)" }}>
                &quot;{search.trim()}&quot;
              </span>
              .
            </>
          ) : (
            <>
              No saved contacts yet.
              <br />
              <span style={{ color: "var(--fg-400)", fontSize: 11 }}>
                Add contacts from the hamburger menu &gt; Contacts.
              </span>
            </>
          )}
        </div>
      ) : (
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            margin: "0 -4px",
          }}
        >
          {entries.map((c) => (
            <ContactPickerRow
              key={c.address}
              contact={c}
              onPick={() => {
                onSelect(c);
                onClose();
              }}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

interface ContactPickerRowProps {
  contact: ContactRecord;
  onPick: () => void;
}

function ContactPickerRow({ contact, onPick }: ContactPickerRowProps) {
  const initial = contact.name.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        display: "grid",
        gridTemplateColumns: "32px 1fr",
        gap: 10,
        alignItems: "center",
        width: "100%",
        padding: "8px 10px",
        borderRadius: 8,
        background: "transparent",
        border: "none",
        color: "var(--fg-100)",
        textAlign: "left",
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(255,255,255,0.04)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: "50%",
          background: "var(--gold-bg)",
          border: "1px solid rgba(242,180,65,0.4)",
          color: "var(--gold)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--f-mono)",
          fontWeight: 600,
          fontSize: 13,
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--fg-100)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={contact.name}
        >
          {contact.name}
        </div>
        <div
          style={{
            fontFamily: "var(--f-mono)",
            fontSize: 10,
            color: "var(--fg-400)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 1,
          }}
          title={contact.bech32m}
        >
          {contact.bech32m}
        </div>
      </div>
    </button>
  );
}
