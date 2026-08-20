import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";

export function buildDeployArguments(network: string, tag?: string): string[] {
  const args = ["deploy", "--network", network];
  if (tag) args.push("--tags", tag, "--no-compile");
  return args;
}

function main() {
  const network = process.argv[2];
  const tag = process.argv[3];
  if (!network) throw new Error("usage: deployActive <network> [tag]");

  const repositoryRoot = resolve(__dirname, "..");
  const hardhatCli = require.resolve("hardhat/internal/cli/cli");
  if (tag) {
    const result = spawnSync(process.execPath, [hardhatCli, ...buildDeployArguments(network, tag)], {
      cwd: repositoryRoot,
      env: { ...process.env, DEPLOY_ACTIVE_TAG: tag },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }

  const sourceDirectory = join(repositoryRoot, "deploy");
  const activeDirectory = mkdtempSync(join(tmpdir(), "zkp2p-active-deploy-"));

  try {
    for (const filename of readdirSync(sourceDirectory)) {
      if (!filename.endsWith(".ts")) continue;
      symlinkSync(join(sourceDirectory, filename), join(activeDirectory, basename(filename)), "file");
    }

    const result = spawnSync(
      process.execPath,
      [hardhatCli, ...buildDeployArguments(network), "--deploy-scripts", activeDirectory],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(activeDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) main();
