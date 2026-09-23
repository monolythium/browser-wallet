// A confirmation key carries its creation time so a stale key cannot become a
// fresh signing authorization after its durable tombstone is eventually evicted.
// The UUID makes distinct confirmations independent; the timestamp is a safety
// backstop, not an authentication token (popup IPC is separately gated).
export const SEND_CONFIRMATION_KEY_MAX_AGE_MS = 15 * 60 * 1000;

export function mintSendConfirmationKey(): string {
  return `s1.${Date.now()}.${crypto.randomUUID()}`;
}

export function isFreshSendConfirmationKey(key: string, now: number): boolean {
  const match = /^s1\.(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  return Number.isSafeInteger(issuedAt) && issuedAt <= now && now - issuedAt <= SEND_CONFIRMATION_KEY_MAX_AGE_MS;
}
