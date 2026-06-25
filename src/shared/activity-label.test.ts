import { describe, expect, it } from "vitest";
import {
  CLAIM_PENDING_LABEL,
  delegationPendingLabel,
  redelegateConfirmedLabel,
} from "./activity-label.js";

describe("delegationPendingLabel", () => {
  it("delegate — present-continuous with % and the named cluster", () => {
    expect(delegationPendingLabel("delegate", 1250, "halcyon")).toBe(
      "Delegating 12.50% to halcyon",
    );
  });

  it("undelegate — % from the named cluster", () => {
    expect(delegationPendingLabel("undelegate", 5000, "halcyon")).toBe(
      "Undelegating 50.00% from halcyon",
    );
  });

  it("redelegate — % from src to dst", () => {
    expect(delegationPendingLabel("redelegate", 1250, "halcyon", "polar")).toBe(
      "Redelegating 12.50% from halcyon to polar",
    );
  });

  it("omits the % cleanly when bps is absent (legacy row, no-mock)", () => {
    expect(delegationPendingLabel("delegate", undefined, "halcyon")).toBe(
      "Delegating to halcyon",
    );
    expect(delegationPendingLabel("delegate", null, "halcyon")).toBe(
      "Delegating to halcyon",
    );
  });

  it("redelegate without a resolved destination drops the ' to …' segment", () => {
    expect(delegationPendingLabel("redelegate", 1250, "halcyon")).toBe(
      "Redelegating 12.50% from halcyon",
    );
  });

  it("honest #id fallback (the caller resolves the label)", () => {
    expect(delegationPendingLabel("delegate", 1250, "Cluster #3")).toBe(
      "Delegating 12.50% to Cluster #3",
    );
  });
});

describe("redelegateConfirmedLabel", () => {
  it("past tense with %", () => {
    expect(redelegateConfirmedLabel(1250, "halcyon", "polar")).toBe(
      "Redelegated 12.50% from halcyon to polar",
    );
  });

  it("no bps → no % (legacy)", () => {
    expect(redelegateConfirmedLabel(null, "halcyon", "polar")).toBe(
      "Redelegated from halcyon to polar",
    );
  });

  it("no destination → 'from …' only", () => {
    expect(redelegateConfirmedLabel(1250, "halcyon")).toBe(
      "Redelegated 12.50% from halcyon",
    );
  });
});

describe("CLAIM_PENDING_LABEL", () => {
  it("is the present-continuous claim label", () => {
    expect(CLAIM_PENDING_LABEL).toBe("Claiming rewards");
  });
});
