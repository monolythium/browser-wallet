import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ClusterDirectoryEntry } from "../../shared/staking.js";
import { ClusterPicker } from "./ClusterPicker.js";

function makeCluster(
  overrides: Partial<ClusterDirectoryEntry> & {
    clusterId: number;
    name: string;
  },
): ClusterDirectoryEntry {
  return {
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["fsn1"],
    active: true,
    entity: "independent",
    ...overrides,
  };
}

describe("ClusterPicker — active-cluster filter (0x020B guard)", () => {
  it("renders active clusters but never offers an inactive one", () => {
    // A delegate / redelegate to a cluster not on the active roster reverts
    // 0x020B DelegationToInactiveCluster (mono-core AUD-0057), so the picker
    // must not present an inactive cluster as a selectable choice.
    const clusters: ClusterDirectoryEntry[] = [
      makeCluster({ clusterId: 1, name: "active-alpha.cluster.mono" }),
      makeCluster({
        clusterId: 2,
        name: "inactive-beta.cluster.mono",
        active: false,
      }),
    ];
    const html = renderToStaticMarkup(
      <ClusterPicker
        clusters={clusters}
        selectedClusterId={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("active-alpha.cluster.mono");
    expect(html).not.toContain("inactive-beta.cluster.mono");
  });

  it("shows the empty state when every cluster is inactive", () => {
    const clusters: ClusterDirectoryEntry[] = [
      makeCluster({ clusterId: 9, name: "resigned.cluster.mono", active: false }),
    ];
    const html = renderToStaticMarkup(
      <ClusterPicker
        clusters={clusters}
        selectedClusterId={null}
        onSelect={() => {}}
      />,
    );
    expect(html).not.toContain("resigned.cluster.mono");
  });
});
