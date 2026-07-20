import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";

const IMMUTABLE_HISTORICAL_SCRIPTS = new Set([
  "26_deploy_stake_risk_system.ts",
]);

function main() {
  const network = process.argv[2];
  if (!network) throw new Error("usage: deployActive <network>");

  const repositoryRoot = resolve(__dirname, "..");
  const sourceDirectory = join(repositoryRoot, "deploy");
  const activeDirectory = mkdtempSync(join(tmpdir(), "zkp2p-active-deploy-"));

  try {
    for (const filename of readdirSync(sourceDirectory)) {
      if (!filename.endsWith(".ts") || IMMUTABLE_HISTORICAL_SCRIPTS.has(filename)) continue;
      symlinkSync(join(sourceDirectory, filename), join(activeDirectory, basename(filename)), "file");
    }

    const hardhatCli = require.resolve("hardhat/internal/cli/cli");
    const result = spawnSync(
      process.execPath,
      [hardhatCli, "deploy", "--network", network, "--deploy-scripts", activeDirectory],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(activeDirectory, { recursive: true, force: true });
  }
}

main();
