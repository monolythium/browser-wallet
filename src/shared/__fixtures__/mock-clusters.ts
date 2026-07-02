// Test fixture: a realistic cluster-directory shape for the autovote
// algorithm tests. Numbers are illustrative-only: they preserve the
// whitepaper §14 + §23 architecture (10 operators per cluster, 7-of-10
// threshold, mixed region diversity, mixed entity flags including
// Foundation clusters per §30.5). Not consumed by any shipped read path
// (readClusterDirectory propagates ok:false with no fixture fallback);
// lives under __fixtures__ so the shipped bundle does not carry it.

import type { ClusterDirectoryEntry } from "../staking.js";

export const MOCK_CLUSTERS: ReadonlyArray<ClusterDirectoryEntry> = [
  {
    clusterId: 1,
    name: "halcyon.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["fsn1", "nbg1", "hel1"],
    active: true,
    entity: "mono-labs",
  },
  {
    clusterId: 2,
    name: "north-mesh.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["ash", "fsn1", "sin"],
    active: true,
    entity: "mono-labs",
  },
  {
    clusterId: 3,
    name: "polar.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["sin", "ash"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 4,
    name: "ember.cluster.mono",
    size: 10,
    threshold: 7,
    health: "degraded",
    regions: ["hel1", "nbg1"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 5,
    name: "salt.cluster.mono",
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["ash", "fsn1"],
    active: true,
    entity: "independent",
  },
  {
    clusterId: 6,
    name: null, // mid-registration cluster — no name yet
    size: 10,
    threshold: 7,
    health: "healthy",
    regions: ["sin"],
    active: true,
    entity: "independent",
  },
];
