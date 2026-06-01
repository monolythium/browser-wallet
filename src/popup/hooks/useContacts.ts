// Contacts reactive read.
//
// Mirrors useConnectedSites: initial chrome.storage.local.get, then a
// chrome.storage.onChanged listener that pushes incremental updates so
// the popup re-renders on every contacts-add / -remove / -rename SW
// op without a manual refresh round-trip.

import { useEffect, useState } from "react";
import { STORAGE_KEY_CONTACTS } from "../../shared/constants";
import type { ContactsMap } from "../bg";

export interface UseContactsResult {
  contacts: ContactsMap;
  loading: boolean;
}

export function useContacts(): UseContactsResult {
  const [contacts, setContacts] = useState<ContactsMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    chrome.storage.local.get(STORAGE_KEY_CONTACTS, (res) => {
      if (cancelled) return;
      const map =
        (res?.[STORAGE_KEY_CONTACTS] as ContactsMap | undefined) ?? {};
      setContacts(map);
      setLoading(false);
    });

    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
      changes,
      areaName,
    ) => {
      if (areaName !== "local") return;
      const change = changes[STORAGE_KEY_CONTACTS];
      if (!change) return;
      setContacts((change.newValue as ContactsMap | undefined) ?? {});
    };
    chrome.storage.onChanged.addListener(listener);

    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return { contacts, loading };
}
