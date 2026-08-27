import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

export const IMMUTABLE_DEPLOYMENT_LANES = {
  // PR #237 commit executed on Base and is shared with lane 30.
  "29_deploy_whitelist_policy.ts": {
    deployedSourceSha: "3c4c1306dcce6693cf32300d8917d45c4604b84e",
    sha256: "95ee7660bdb069e1d31ea0e843f557b05f2ea76697766fec0d2146f8ec44d842",
    activeSource: undefined,
    retired: false,
    tags: [
      "29_deploy_whitelist_policy",
      "V2WhitelistPolicy",
      "WhitelistPolicy",
    ],
  },
  "30_deploy_v3_lifecycle_stack.ts": {
    deployedSourceSha: "3c4c1306dcce6693cf32300d8917d45c4604b84e",
    sha256: "97ed83a35e91167186da7a1bde9d3534e6eced436a843a0afd07c0f055bf20fa",
    activeSource:
      "deployments/activeDeploymentLanes/30_deploy_v3_lifecycle_stack.ts",
    retired: false,
    tags: [
      "30_deploy_v3_lifecycle_stack",
      "V3LifecycleStack",
      "OrchestratorV3",
    ],
  },
  "32_deploy_and_activate_dispute_lifecycle_stack.ts": {
    deployedSourceSha: "d5558c2888c9246448e1926135fd0c2cbeceb3e4",
    sha256: "e103f2b9eb4168504cb226a6191a05c432e313ca5b649b0cc2a3d77fb3a5d283",
    activeSource: null,
    retired: true,
    tags: [
      "32_deploy_and_activate_dispute_lifecycle_stack",
      "V3DisputeLifecycleStack",
    ],
  },
  // PR #269 executed on Base with digest 37d50a81...; PR #270 then relocated the predecessor import.
  "34_deploy_opt_in_dispute_lifecycle_stack.ts": {
    deployedSourceSha: "f0ec8b109c36d253486be072e910d54db2432f7e",
    sha256: "82562509fdf6acbf64c1fe6e1b7a39ff8d08ef324a680231e5b7b6a64243ba17",
    activeSource: null,
    retired: true,
    tags: ["34_deploy_opt_in_dispute_lifecycle_stack", "V3DisputeOptInStack"],
  },
  // PR #282 commit executed on Base; lane stays mounted, its skip canonical-checks the record.
  "36_deploy_method_scoped_whitelist_policy.ts": {
    deployedSourceSha: "7316a5ece51d56419d0b02c9cd3c29c8ff5ba4be",
    sha256: "3bc01ba3e308a2d9cbaa58a95a7094c5ed2116df103ff6fbb997962cc9240fde",
    activeSource: undefined,
    retired: false,
    tags: [
      "36_deploy_method_scoped_whitelist_policy",
      "MethodScopedWhitelistPolicy",
    ],
  },
  // Executed on Base staging and Base 2026-08-27 (PRs #282/#284); retired for live networks; local networks deploy through the wrapper.
  "37_deploy_method_scoped_dispute_lifecycle_stack.ts": {
    deployedSourceSha: "de4a96a1039246a8eefdaeb6d7b643504f605fe6",
    sha256: "fb19ffe1724d34d95097bddc28d0068218e06346ff1e5ea5c4a6aedd7d8a40c6",
    activeSource:
      "deployments/activeDeploymentLanes/37_deploy_method_scoped_dispute_lifecycle_stack.ts",
    retired: true,
    tags: [
      "37_deploy_method_scoped_dispute_lifecycle_stack",
      "V3DisputeMethodScopedStack",
    ],
  },
} as const;

export type DeploymentLanes = Readonly<
  Record<
    string,
    {
      activeSource?: string | null;
      retired: boolean;
      tags: readonly string[];
    }
  >
>;

export function assertImmutableDeploymentLanes(repositoryRoot: string): void {
  for (const [filename, evidence] of Object.entries(
    IMMUTABLE_DEPLOYMENT_LANES
  )) {
    const source = readFileSync(resolve(repositoryRoot, "deploy", filename));
    const actual = createHash("sha256").update(source).digest("hex");
    if (actual !== evidence.sha256) {
      throw new Error(
        `Invalid immutable deployment lane ${filename}: expected ${evidence.sha256}, found ${actual}`
      );
    }
  }
}

export function selectActiveDeploymentScripts(
  repositoryRoot: string,
  filenames: readonly string[],
  lanes: DeploymentLanes = IMMUTABLE_DEPLOYMENT_LANES
): Array<{ filename: string; sourcePath: string }> {
  return filenames.flatMap((filename) => {
    const immutableLane = lanes[filename];
    if (immutableLane?.activeSource === null) return [];
    return [
      {
        filename,
        sourcePath: immutableLane?.activeSource
          ? resolve(repositoryRoot, immutableLane.activeSource)
          : resolve(repositoryRoot, "deploy", filename),
      },
    ];
  });
}

export function assertSupportedDeploymentTag(
  tag: string | undefined,
  lanes: DeploymentLanes = IMMUTABLE_DEPLOYMENT_LANES
): void {
  if (!tag) return;
  if (tag.includes(",")) {
    throw new Error("deployActive accepts exactly one deployment tag");
  }
  const retiredTag = Object.values(lanes).some(
    (lane) => lane.retired && (lane.tags as readonly string[]).includes(tag)
  );
  if (retiredTag) {
    throw new Error(`Refusing retired deployment tag: ${tag}`);
  }
}
