import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DelegationRejectedBanner,
  type DelegationRejection,
} from "./DelegationRejectedBanner";

const rejection: DelegationRejection = {
  clusterId: 2,
  clusterName: "genesis-cluster-2",
  kind: "delegate",
  message: "This cluster is already at the 50% per-wallet cap.",
  atMs: 1_700_000_000_000,
};

describe("DelegationRejectedBanner", () => {
  it("renders nothing when there is no rejection", () => {
    const html = renderToStaticMarkup(
      <DelegationRejectedBanner rejection={null} onDismiss={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("shows the cluster name + the cap message + a dismiss control", () => {
    const html = renderToStaticMarkup(
      <DelegationRejectedBanner rejection={rejection} onDismiss={() => {}} />,
    );
    expect(html).toContain("genesis-cluster-2");
    expect(html).toContain("50% per-wallet cap");
    expect(html).toContain('role="alert"');
    expect(html).toContain("aria-label=\"Dismiss delegation-rejected notice\"");
  });

  it("falls back to 'cluster #id' when no captured name", () => {
    const html = renderToStaticMarkup(
      <DelegationRejectedBanner
        rejection={{ ...rejection, clusterName: null }}
        onDismiss={() => {}}
      />,
    );
    expect(html).toContain("cluster #2");
  });
});
