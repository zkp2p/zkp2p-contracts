import { BigNumber, constants, utils } from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { paymentBindingCutoverReady } from "../deploy/31_deploy_v3_payment_binding_stack";
import { assertDeploymentMatchesChain } from "./canonicalDeployment";

export const UPV4_BOOTSTRAP_TAG = "43_deploy_unified_payment_verifier_v4";
export const VENMO_METHOD = utils.id("venmo");
export const VENMO_BALANCE_METHOD = utils.id("venmo-balance");

export function bootstrapRequested(network: string): boolean {
  const flags = {
    base: "ENABLE_BASE_UPV4_BOOTSTRAP",
    base_staging: "ENABLE_STAGING_UPV4_BOOTSTRAP",
  };
  const selected = process.env.DEPLOY_ACTIVE_TAG === UPV4_BOOTSTRAP_TAG;
  const enabled = Object.values(flags).some(
    (flag) => process.env[flag] === "true"
  );
  if (!selected) {
    if (enabled)
      throw new Error(`UPV4 bootstrap flags require ${UPV4_BOOTSTRAP_TAG}`);
    return false;
  }
  if (network === "hardhat" || network === "localhost") {
    if (enabled)
      throw new Error(
        "Live UPV4 bootstrap flags cannot target a local network"
      );
    return true;
  }
  if (network !== "base" && network !== "base_staging") {
    throw new Error(`UPV4 bootstrap does not support ${network}`);
  }
  const flag = flags[network];
  if (process.env[flag] !== "true")
    throw new Error(`UPV4 bootstrap requires ${flag}=true`);
  const otherFlag = flags[network === "base" ? "base_staging" : "base"];
  if (process.env[otherFlag] === "true")
    throw new Error("UPV4 bootstrap has conflicting network flags");
  return true;
}

export type NamespaceEntry = { method: string; namespace: string };

export function bootstrapNamespaces(methods: string[]): NamespaceEntry[] {
  if (
    !methods.includes(VENMO_METHOD) ||
    methods.includes(VENMO_BALANCE_METHOD) ||
    methods.includes(constants.HashZero) ||
    new Set(methods).size !== methods.length
  ) {
    throw new Error(
      "UPV4 bootstrap requires distinct predecessor methods including regular Venmo only"
    );
  }
  return [
    ...methods.map((method) => ({ method, namespace: method })),
    { method: VENMO_BALANCE_METHOD, namespace: VENMO_METHOD },
  ];
}

export function assertAliasRiskWindows(
  entries: NamespaceEntry[],
  riskWindows: string[]
): void {
  if (entries.length !== riskWindows.length)
    throw new Error("Missing method risk windows");
  entries.forEach(({ method, namespace }, index) => {
    if (method !== namespace && !BigNumber.from(riskWindows[index]).isZero()) {
      throw new Error(`Protected nullifier aliases are unsupported: ${method}`);
    }
  });
}

export function assertNamespacePrefix(
  expected: NamespaceEntry[],
  methods: string[],
  namespaces: string[],
  active: boolean[]
): number {
  if (
    methods.length > expected.length ||
    namespaces.length !== expected.length ||
    active.length !== expected.length ||
    methods.some((method, index) => method !== expected[index].method)
  ) {
    throw new Error("UPV4 methods are not an exact bootstrap prefix");
  }
  expected.forEach((entry, index) => {
    const configured = index < methods.length;
    if (
      active[index] !== configured ||
      namespaces[index] !== (configured ? entry.namespace : constants.HashZero)
    ) {
      throw new Error(
        `UPV4 namespace or active flag mismatch: ${entry.method}`
      );
    }
  });
  return methods.length;
}

// This is a passive-deployment snapshot, not an activation manifest. Lane 31's
// ratified live identity checks are an additional preflight. All values below
// are then read together at one block and must remain unchanged during bootstrap.
export async function readBootstrapPredecessor(hre: HardhatRuntimeEnvironment) {
  if (!(await paymentBindingCutoverReady(hre))) {
    throw new Error(
      "UPV4 bootstrap requires the intact UPV3 payment-binding cutover"
    );
  }
  const block = await hre.ethers.provider.getBlock("latest");
  const at = { blockTag: block.number };
  const getContract = async (name: string, artifact = name) => {
    const record = await hre.deployments.get(name);
    await assertDeploymentMatchesChain(
      hre,
      record,
      name,
      artifact,
      block.number
    );
    return hre.ethers.getContractAt(artifact, record.address);
  };
  const predecessor = await getContract("UnifiedPaymentVerifierV3");
  const registry = await getContract("NullifierRegistryV2");
  const legacy = await getContract("NullifierRegistry");
  const routes = await getContract("PaymentVerifierRegistry");
  const orchestrators = await getContract("OrchestratorRegistry");
  const orchestrator = await getContract("OrchestratorV3");
  const hook = await getContract(
    "IntentLifecycleHookV1MethodScopedStaked",
    "IntentLifecycleHookV1"
  );
  const policy = await getContract(
    "DisputeProtectionPolicyMethodScopedStaked",
    "DisputeProtectionPolicy"
  );
  const governance = await predecessor.owner(at);
  const same = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  if (
    !same(await predecessor.nullifierRegistry(at), registry.address) ||
    !same(await predecessor.orchestratorRegistry(at), orchestrators.address) ||
    !same(await registry.legacyNullifierRegistry(at), legacy.address) ||
    !same(await orchestrator.paymentVerifierRegistry(at), routes.address) ||
    !same(await orchestrator.lifecycleHook(at), hook.address) ||
    !same(await hook.orchestratorRegistry(at), orchestrators.address) ||
    !same(await hook.disputeProtectionPolicy(at), policy.address) ||
    !(await orchestrators.isOrchestrator(orchestrator.address, at)) ||
    !(await policy.isLifecycleHookAuthorized(hook.address, at))
  ) {
    throw new Error(
      "UPV4 predecessor dependency or active lifecycle pointer mismatch"
    );
  }
  for (const contract of [
    registry,
    legacy,
    routes,
    orchestrators,
    orchestrator,
    policy,
  ]) {
    if (!same(await contract.owner(at), governance))
      throw new Error("UPV4 predecessor governance mismatch");
  }
  const writers: string[] = await registry.getWriters(at);
  if (
    writers.length !== 1 ||
    !same(writers[0], predecessor.address) ||
    (await legacy.getWriters(at)).length
  ) {
    throw new Error(
      "UPV4 bootstrap requires UPV3 as the sole writer and no legacy writers"
    );
  }
  const methods: string[] = await routes.getPaymentMethods(at);
  const predecessorMethods: string[] = await predecessor.getPaymentMethods(at);
  if (
    predecessorMethods.length !== methods.length ||
    predecessorMethods.some((method) => !methods.includes(method))
  ) {
    throw new Error("UPV4 predecessor method set differs from its routes");
  }
  const entries = bootstrapNamespaces(methods);
  const currencies: string[][] = [];
  for (const method of methods) {
    if (
      !(await predecessor.isPaymentMethod(method, at)) ||
      !same(await routes.getVerifier(method, at), predecessor.address)
    ) {
      throw new Error(
        "UPV4 bootstrap found an inactive method or partial route cutover"
      );
    }
    const configured: string[] = await routes.getCurrencies(method, at);
    if (configured.length === 0)
      throw new Error(`UPV4 predecessor has no currencies: ${method}`);
    currencies.push(configured);
  }
  const riskWindows: string[] = [];
  for (const { method } of entries)
    riskWindows.push((await policy.getRiskWindow(method, at)).toString());
  assertAliasRiskWindows(entries, riskWindows);
  const attestationVerifier: string = await predecessor.attestationVerifier(at);
  const attestationCode = await hre.ethers.provider.getCode(
    attestationVerifier,
    block.number
  );
  if (attestationCode === "0x")
    throw new Error("UPV4 predecessor attestation verifier has no code");
  const state = {
    chainId: (await hre.ethers.provider.getNetwork()).chainId,
    predecessor: predecessor.address,
    nullifierRegistry: registry.address,
    legacyNullifierRegistry: legacy.address,
    orchestratorRegistry: orchestrators.address,
    paymentVerifierRegistry: routes.address,
    attestationVerifier,
    attestationCodeHash: utils.keccak256(attestationCode),
    governance,
    orchestrator: orchestrator.address,
    hook: hook.address,
    policy: policy.address,
    entries,
    currencies,
    riskWindows,
    writers,
  };
  return { blockNumber: block.number, blockHash: block.hash, state };
}
