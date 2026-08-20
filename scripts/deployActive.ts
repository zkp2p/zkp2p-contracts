import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import {
  assertImmutableDeploymentLanes,
  assertSupportedDeploymentTag,
  selectActiveDeploymentScripts,
} from "../deployments/immutableDeploymentLanes";

export function buildDeployArguments(
  network: string,
  activeDirectory: string,
  tag?: string
): string[] {
  const args = ["deploy", "--network", network];
  if (tag) args.push("--tags", tag, "--no-compile");
  args.push("--deploy-scripts", activeDirectory);
  return args;
}

type SpawnResult = { error?: Error; status: number | null };
type Spawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: "inherit";
  }
) => SpawnResult;

type ActiveDeploymentOptions = {
  repositoryRoot?: string;
  hardhatCli?: string;
  env?: NodeJS.ProcessEnv;
  spawnSync?: Spawn;
  temporaryRoot?: string;
};

export function runActiveDeployment(
  network: string,
  tag?: string,
  options: ActiveDeploymentOptions = {}
): number {
  assertSupportedDeploymentTag(tag);
  const repositoryRoot = options.repositoryRoot ?? resolve(__dirname, "..");
  assertImmutableDeploymentLanes(repositoryRoot);
  const hardhatCli =
    options.hardhatCli ?? require.resolve("hardhat/internal/cli/cli");
  const spawn = options.spawnSync ?? (spawnSync as Spawn);

  const sourceDirectory = join(repositoryRoot, "deploy");
  const activeDirectory = mkdtempSync(
    join(options.temporaryRoot ?? tmpdir(), "zkp2p-active-deploy-")
  );

  try {
    const filenames = readdirSync(sourceDirectory).filter((filename) =>
      filename.endsWith(".ts")
    );
    for (const { filename, sourcePath } of selectActiveDeploymentScripts(
      repositoryRoot,
      filenames
    )) {
      symlinkSync(sourcePath, join(activeDirectory, filename), "file");
    }

    const childEnvironment = { ...(options.env ?? process.env) };
    if (tag) childEnvironment.DEPLOY_ACTIVE_TAG = tag;
    else delete childEnvironment.DEPLOY_ACTIVE_TAG;
    const result = spawn(
      process.execPath,
      [hardhatCli, ...buildDeployArguments(network, activeDirectory, tag)],
      { cwd: repositoryRoot, env: childEnvironment, stdio: "inherit" }
    );
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(activeDirectory, { recursive: true, force: true });
  }
}

function main() {
  const network = process.argv[2];
  const tag = process.argv[3];
  if (!network) throw new Error("usage: deployActive <network> [tag]");
  const status = runActiveDeployment(network, tag);
  if (status !== 0) process.exitCode = status;
}

if (require.main === module) main();
