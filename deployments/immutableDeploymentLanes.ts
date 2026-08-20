import { createHash } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

export const IMMUTABLE_DEPLOYMENT_LANES = {
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
} as const;

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
  filenames: readonly string[]
): Array<{ filename: string; sourcePath: string }> {
  return filenames.flatMap((filename) => {
    const immutableLane =
      IMMUTABLE_DEPLOYMENT_LANES[
        filename as keyof typeof IMMUTABLE_DEPLOYMENT_LANES
      ];
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

export function assertSupportedDeploymentTag(tag: string | undefined): void {
  if (!tag) return;
  if (tag.includes(",")) {
    throw new Error("deployActive accepts exactly one deployment tag");
  }
  const retiredTags = IMMUTABLE_DEPLOYMENT_LANES[
    "32_deploy_and_activate_dispute_lifecycle_stack.ts"
  ].tags as readonly string[];
  if (retiredTags.includes(tag)) {
    throw new Error(`Refusing retired deployment tag: ${tag}`);
  }
}
