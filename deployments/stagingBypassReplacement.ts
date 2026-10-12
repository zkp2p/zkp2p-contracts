import { deploymentCodeMatchesRecord } from "./canonicalDeployment";
import { reduceBypassActivation } from "./bypassDisputeActivation";
import type {
  BypassActivationSnapshot,
  BypassExpectedActivationState,
} from "./bypassDisputeActivation";

export const LANE_47_TAG = "47_replace_staging_bypass_stack";
export const LIVE_FLAGS = {
  prepare: "PREPARE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT",
  execute: "ENABLE_STAGING_V3_DISPUTE_BYPASS_REPLACEMENT",
} as const;
// Historical identities must survive overwriting the three canonical records and later pin updates.
export const SUPERSEDED = {
  StakeVaultBypass: "0xAca0d2e3C91182F2310446B2Eda0010E593DDEe6",
  DisputeProtectionPolicyBypass: "0x4bF03895eB7126c605D915b84A8c775D0f4C6C0B",
  IntentLifecycleHookV1Bypass: "0x2c1E846fA3887FfCbfD1F556d0FA6F4EC5899029",
} as const;
export type TrioName = keyof typeof SUPERSEDED;
// Lane-45 staging receipt, preserved before the canonical policy record is overwritten.
export const SUPERSEDED_POLICY_BLOCK = 52483257;
export const SUPERSEDED_POLICY_RUNTIME_HASH =
  "0x1ccd36086e5fb3b3816397a6c453280a0ac4ebd575bc4e2c80aa7e43167739d4";
// Accept lane 45's exported order without importing its Hardhat-dependent module here.
export function replacementSteps(lane45Steps: readonly string[]): string[] {
  const verifierIndex = lane45Steps.indexOf("deploy-verifier");
  requireState(verifierIndex > 0, "Lane 45 deployment order lacks verifier boundary");
  return [
    ...lane45Steps.slice(0, verifierIndex),
    "add-policy-writer",
    "set-lifecycle-hook",
    "remove-superseded-writer",
  ];
}
export const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export function requireState(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function replacementMode(
  network: string,
  env: NodeJS.ProcessEnv
): "skip" | "prepare" | "execute" {
  if (env.DEPLOY_ACTIVE_TAG !== LANE_47_TAG) return "skip";
  requireState(network !== "base", "Lane 47 is staging-only; Base must use lanes 45/46 unchanged");
  if (network !== "base_staging") return "skip";
  const prepare = env[LIVE_FLAGS.prepare] === "true";
  const execute = env[LIVE_FLAGS.execute] === "true";
  requireState(
    prepare !== execute,
    `Lane 47 requires exactly one of ${LIVE_FLAGS.prepare} or ${LIVE_FLAGS.execute}=true`
  );
  return prepare ? "prepare" : "execute";
}
export function isReplacement(name: TrioName, address?: string): boolean {
  return !!address && !same(address, SUPERSEDED[name]);
}
export function classifyReplacement(
  completed: readonly boolean[],
  steps: readonly string[]
): number | null {
  requireState(completed.length === steps.length, "Lane 47 state length mismatch");
  const next = completed.indexOf(false);
  requireState(
    next < 0 || !completed.slice(next + 1).some(Boolean),
    "Lane 47 state is not a contiguous prefix"
  );
  return next < 0 ? null : next;
}
function executable(code: string): string {
  requireState(/^0x[0-9a-fA-F]+$/.test(code) && code.length % 2 === 0, "Invalid policy bytecode");
  const metadataBytes = parseInt(code.slice(-4), 16) + 2;
  requireState(metadataBytes * 2 < code.length - 2, "Invalid policy metadata length");
  return code.slice(0, -metadataBytes * 2);
}
export function assertArtifactSourcesCurrent(
  artifactName: string,
  metadata: unknown,
  hashSource: (sourceName: string) => string | undefined
): void {
  const invalid = `Lane 47 stale ${artifactName} artifact: invalid source metadata; compile before retrying`;
  requireState(typeof metadata === "string", invalid);
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    requireState(false, invalid);
  }
  requireState(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed), invalid);
  const sources = (parsed as Record<string, unknown>).sources;
  requireState(typeof sources === "object" && sources !== null && !Array.isArray(sources), invalid);
  const projectSources = Object.entries(sources).filter(([name]) => name.startsWith("contracts/"));
  requireState(projectSources.length > 0, invalid);
  for (const [name, source] of projectSources) {
    const mismatch = `Lane 47 stale ${artifactName} artifact: ${name} source hash mismatch; compile before retrying`;
    requireState(typeof source === "object" && source !== null && !Array.isArray(source), mismatch);
    const expected = (source as Record<string, unknown>).keccak256;
    requireState(typeof expected === "string", mismatch);
    const actual = hashSource(name);
    requireState(typeof actual === "string" && same(actual, expected), mismatch);
  }
}
export function assertPolicyBuildChanged(artifact: string, supersededCode: string): void {
  // Ignore CBOR metadata and constructor immutable slots (zeroes in artifact runtime).
  requireState(
    !deploymentCodeMatchesRecord(executable(artifact), executable(supersededCode)),
    "Lane 47 stale DisputeProtectionPolicy artifact: executable runtime matches superseded policy; compile before retrying"
  );
}
export function replacementWriters(
  predecessor: string,
  policy: string | undefined,
  added: boolean,
  removed: boolean
): string[] {
  requireState(!removed || added, "Superseded writer removed before adding replacement");
  requireState(!added || !!policy, "Replacement writer lacks policy record");
  // add appends [August, superseded, new]; swap-and-pop removal at index 1 yields [August, new].
  return [
    predecessor,
    ...(!removed ? [SUPERSEDED.DisputeProtectionPolicyBypass] : []),
    ...(added ? [policy!] : []),
  ];
}
export function assertMountedHook(mounted: string, fresh?: string): void {
  requireState(
    same(mounted, SUPERSEDED.IntentLifecycleHookV1Bypass) || (!!fresh && same(mounted, fresh)),
    "Lane 47 mounted lifecycle hook is neither superseded nor replacement"
  );
}
export function assertReplacementActive(
  snapshot: BypassActivationSnapshot,
  expected: BypassExpectedActivationState
): void {
  const result = reduceBypassActivation(snapshot, expected);
  requireState(
    result.phase === "active",
    `Lane 47 final state is not lane-46 active: ${result.violations.join(", ")}`
  );
}
