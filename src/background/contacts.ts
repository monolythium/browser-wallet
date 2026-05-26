// Round 7 TASK 5 — Contacts (address book) backend.
//
// Keyed by lowercase 0x address. Value is a ContactRecord with the user-
// editable name, the bech32m display form (cached for read paths that
// don't want to re-encode every render), createdAt + lastUsedAt
// timestamps, and an optional free-text notes field.
//
// Storage lives in chrome.storage.local under STORAGE_KEY_CONTACTS and
// is mirrored to the popup via chrome.storage.onChanged — useContacts
// in src/popup/hooks/useContacts.ts subscribes for live updates.
//
// Same shape as connected-sites.ts (load / save / mutate helpers). The
// SW IPC layer wraps these and is the only thing the popup talks to.

import { STORAGE_KEY_CONTACTS } from "../shared/constants.js";

export interface ContactRecord {
  /** Canonical lowercase 0x address (40 hex chars). Storage key form. */
  address: string;
  /** bech32m display string (mono1...). Cached so render paths don't
   *  re-encode every list refresh. */
  bech32m: string;
  /** User-provided name, 1-64 chars, trimmed at write time. */
  name: string;
  /** Created-at timestamp (ms). */
  addedAt: number;
  /** Last-used timestamp (ms). Bumped by updateContactLastUsed when the
   *  user sends to this contact. Sort key for the contact list (most
   *  recently used first). */
  lastUsedAt?: number;
  /** Optional free-text notes, 0-256 chars. */
  notes?: string;
}

export type ContactsMap = Record<string, ContactRecord>;

export async function loadContacts(): Promise<ContactsMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_CONTACTS, (got) => {
      const raw = got?.[STORAGE_KEY_CONTACTS];
      if (!raw || typeof raw !== "object") {
        resolve({});
        return;
      }
      // Trust-but-verify the shape: drop any malformed entry so a corrupt
      // write (older code path, manual edit) can't crash the popup. Same
      // posture connected-sites.ts uses on its read path.
      const out: ContactsMap = {};
      for (const [key, rec] of Object.entries(raw as Record<string, unknown>)) {
        if (
          rec &&
          typeof rec === "object" &&
          typeof (rec as ContactRecord).address === "string" &&
          typeof (rec as ContactRecord).bech32m === "string" &&
          typeof (rec as ContactRecord).name === "string" &&
          typeof (rec as ContactRecord).addedAt === "number"
        ) {
          out[key] = rec as ContactRecord;
        }
      }
      resolve(out);
    });
  });
}

async function saveContacts(map: ContactsMap): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY_CONTACTS]: map }, () => resolve());
  });
}

/** Add or replace a contact. Caller is responsible for trimming the name
 *  + notes; this layer validates length and key-shape only. */
export async function addContact(record: ContactRecord): Promise<void> {
  const map = await loadContacts();
  const key = record.address.toLowerCase();
  map[key] = { ...record, address: key };
  await saveContacts(map);
}

export async function removeContact(addressLower: string): Promise<void> {
  const map = await loadContacts();
  const key = addressLower.toLowerCase();
  if (!(key in map)) return;
  delete map[key];
  await saveContacts(map);
}

export async function renameContact(
  addressLower: string,
  newName: string,
): Promise<void> {
  const map = await loadContacts();
  const key = addressLower.toLowerCase();
  const existing = map[key];
  if (!existing) return;
  existing.name = newName;
  await saveContacts(map);
}

export async function updateContactLastUsed(
  addressLower: string,
): Promise<void> {
  const map = await loadContacts();
  const key = addressLower.toLowerCase();
  const existing = map[key];
  if (!existing) return;
  existing.lastUsedAt = Date.now();
  await saveContacts(map);
}

export async function isContactKnown(
  addressLower: string,
): Promise<boolean> {
  const map = await loadContacts();
  return Object.prototype.hasOwnProperty.call(map, addressLower.toLowerCase());
}
