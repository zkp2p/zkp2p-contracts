import { execFileSync } from "node:child_process";

export const BASE_GOVERNANCE_CHANGES = "deployments/orchestrator-v4/base.governance-changes.json";

export function releasePaths(environment: string) {
  return {
    deployed: ["contracts", "hardhat.config.ts", "scripts/verify-orchestrator-v4-source.ts", "deployments/canonicalDeployment.ts", `deployments/orchestrator-v4/${environment}.json`],
    execution: ["scripts/orchestrator-v4-governance.ts", ...(environment === "base" ? [BASE_GOVERNANCE_CHANGES] : []), "scripts/deploy-orchestrator-v4.ts", "scripts/canonical-receipts.ts", "scripts/handoff-staging-owner.ts", "scripts/orchestrator-v4-provenance.ts", "hardhat.readonly.config.ts", "hardhat.canonical.config.ts", `deployments/${environment}/Orchestrator.json`, `deployments/${environment}/OrchestratorV4Historical20261016.json`, "deployments/base_staging/Escrow.json", "deployments/orchestrator-v4/historical/2026-10-22",
      `deployments/${environment}/StakeVaultV2Historical20261022.json`, `deployments/${environment}/AddressGroupRegistryV4Historical20261022.json`, `deployments/${environment}/WhitelistPolicyV2Historical20261022.json`, `deployments/${environment}/DisputeProtectionPolicyV2Historical20261022.json`, `deployments/${environment}/UnifiedPaymentVerifierV4Historical20261022.json`, `deployments/${environment}/OrchestratorV4Historical20261022.json`, `deployments/${environment}/ProtocolViewerV4Historical20261022.json`],
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
  const sourceChanges = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", sourceCommit, "HEAD", "--", ...paths.deployed], { encoding: "utf8" }).split("\0").filter(Boolean);
  // Only this Base retirement document may differ. Keep every other path, including
  // files beneath a directory named README.md, bound to the deployed source.
  const protectedChanges = sourceChanges.filter((path) => environment !== "base" || path !== "contracts/archive/README.md");
  if (protectedChanges.length) throw new Error(`Deployment source changed: ${protectedChanges.join(", ")}`);
  execFileSync("git", ["diff", "--exit-code", toolCommit, "HEAD", "--", ...paths.execution], { stdio: "pipe" });
}
