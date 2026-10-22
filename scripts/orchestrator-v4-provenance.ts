import { execFileSync } from "node:child_process";

export function releasePaths(environment: string) {
  return {
    deployed: ["contracts", "hardhat.config.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", `deployments/orchestrator-v4/${environment}.json`],
    execution: ["scripts/deploy-orchestrator-v4.ts", "scripts/canonical-receipts.ts", "scripts/handoff-staging-owner.ts", "scripts/orchestrator-v4-provenance.ts", `deployments/${environment}/Orchestrator.json`, `deployments/${environment}/OrchestratorV4Historical20261016.json`, "deployments/base_staging/Escrow.json"],
  };
}

/** Deployment source remains immutable; a separately reviewed tool revision can strengthen execution checks. */
export function assertReleaseProvenance(sourceCommit: string, executionToolCommit: string | undefined, environment: string): void {
  const paths = releasePaths(environment);
  const toolCommit = executionToolCommit === undefined ? sourceCommit : executionToolCommit;
  for (const commit of [sourceCommit, toolCommit]) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Release provenance requires full commit SHAs");
    execFileSync("git", ["merge-base", "--is-ancestor", commit, "HEAD"], { stdio: "pipe" });
  }
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...paths.deployed, ...paths.execution], { stdio: "pipe" });
  execFileSync("git", ["diff", "--exit-code", sourceCommit, "HEAD", "--", ...paths.deployed], { stdio: "pipe" });
  execFileSync("git", ["diff", "--exit-code", toolCommit, "HEAD", "--", ...paths.execution], { stdio: "pipe" });
}
