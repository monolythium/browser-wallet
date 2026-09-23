import { describe, expect, it } from "vitest";
import {
  SEND_CONFIRMATION_KEY_MAX_AGE_MS,
  isFreshSendConfirmationKey,
  mintSendConfirmationKey,
} from "./send-confirmation-key";

describe("send confirmation keys", () => {
  it("mints a distinct, time-bound key for each new confirmation", () => {
    const now = Date.now();
    const first = mintSendConfirmationKey();
    const second = mintSendConfirmationKey();
    expect(first).not.toBe(second);
    expect(isFreshSendConfirmationKey(first, now + 1000)).toBe(true);
    expect(isFreshSendConfirmationKey(first, now + SEND_CONFIRMATION_KEY_MAX_AGE_MS + 1000)).toBe(false);
  });

  it("refuses old unversioned keys and future-dated keys", () => {
    const now = Date.now();
    expect(isFreshSendConfirmationKey("confirm-1", now)).toBe(false);
    expect(isFreshSendConfirmationKey(`s1.${now + 1}.00000000-0000-4000-8000-000000000001`, now)).toBe(false);
  });
});
