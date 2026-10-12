import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { EXPECTED_LIVE } from "../deploy/37_deploy_method_scoped_dispute_lifecycle_stack";
import {
  assertBypassDeploymentRecord,
  BYPASS_EXPECTED_LIVE,
  BYPASS_RECORDED_DEPLOYMENTS,
  expectedPaymentMethodCurrencies,
  type BypassNetwork,
} from "./bypassDisputeStack";

const { getActiveDisputeDeploymentName } =
  require("./activeDisputeStack.cjs") as {
    getActiveDisputeDeploymentName(
      network: string,
      canonicalName: string
    ): string;
  };

/** The bypass hook requires UPV4 routing. The recorded alias flip is the single
 * switch for a live network's payment binding; recording PRs flip it per network
 * after lane 46 executes. */
export function bypassPaymentBindingRecorded(network: string): boolean {
  return (
    getActiveDisputeDeploymentName(network, "IntentLifecycleHookV1") ===
    "IntentLifecycleHookV1Bypass"
  );
}

function requireState(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function same(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function ordered(actual: string[], expected: string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => same(value, expected[index]))
  );
}

export async function verifyBypassPaymentBinding(
  hre: HardhatRuntimeEnvironment,
  network: BypassNetwork
): Promise<void> {
  const { ethers, deployments } = hre;
  const pins = BYPASS_EXPECTED_LIVE[network];
  const expected = EXPECTED_LIVE[network];
  requireState(
    (await ethers.provider.getNetwork()).chainId === 8453,
    "Payment binding chain id mismatch"
  );
  const verifierPin =
    BYPASS_RECORDED_DEPLOYMENTS[network]?.UnifiedPaymentVerifierV4;
  requireState(!!verifierPin, "UPV4 recorded deployment pin missing");

  const records: Array<[string, string, string]> = [
    [
      "NullifierRegistryV2",
      expected.nullifierRegistryV2,
      expected.nullifierRegistryV2CodeHash,
    ],
    [
      "MultiAttestationVerifier",
      expected.attestationVerifier,
      expected.attestationVerifierCodeHash,
    ],
    ["OrchestratorV3", expected.orchestrator, expected.orchestratorCodeHash],
    [
      "OrchestratorRegistry",
      expected.orchestratorRegistry,
      expected.orchestratorRegistryCodeHash,
    ],
    [
      "PaymentVerifierRegistry",
      pins.paymentVerifierRegistry.address,
      pins.paymentVerifierRegistry.runtimeCodeHash,
    ],
  ];
  for (const [name, address, runtimeCodeHash] of records) {
    const record = await deployments.get(name);
    requireState(
      same(record.address, address),
      `${name} deployment address mismatch`
    );
    requireState(
      ethers.utils.keccak256(await ethers.provider.getCode(address)) ===
        runtimeCodeHash,
      `${name} runtime bytecode hash mismatch`
    );
  }
  const verifierRecord = await deployments.get("UnifiedPaymentVerifierV4");
  await assertBypassDeploymentRecord(
    hre,
    network,
    "UnifiedPaymentVerifierV4",
    verifierRecord
  );
  const verifier = await ethers.getContractAt(
    "UnifiedPaymentVerifierV4",
    verifierRecord.address
  );
  const registry = await ethers.getContractAt(
    "PaymentVerifierRegistry",
    pins.paymentVerifierRegistry.address
  );
  const nullifier = await ethers.getContractAt(
    "NullifierRegistryV2",
    expected.nullifierRegistryV2
  );
  const attestation = await ethers.getContractAt(
    "MultiAttestationVerifier",
    expected.attestationVerifier
  );
  const orchestrator = await ethers.getContractAt(
    "OrchestratorV3",
    expected.orchestrator
  );
  const orchestrators = await ethers.getContractAt(
    "OrchestratorRegistry",
    expected.orchestratorRegistry
  );
  const legacyRecord = await deployments.get("NullifierRegistry");
  const legacy = await ethers.getContractAt(
    "NullifierRegistry",
    legacyRecord.address
  );
  for (const [name, contract] of [
    ["UPV4", verifier],
    ["NullifierRegistryV2", nullifier],
    ["MultiAttestationVerifier", attestation],
    ["OrchestratorV3", orchestrator],
    ["PaymentVerifierRegistry", registry],
    ["NullifierRegistry", legacy],
  ] as const) {
    requireState(
      same(await contract.owner(), pins.governance),
      `${name} owner mismatch`
    );
  }
  requireState(
    same(await verifier.orchestratorRegistry(), expected.orchestratorRegistry),
    "UPV4 orchestrator registry mismatch"
  );
  requireState(
    same(await verifier.nullifierRegistry(), expected.nullifierRegistryV2),
    "UPV4 nullifier registry mismatch"
  );
  requireState(
    same(await verifier.attestationVerifier(), expected.attestationVerifier),
    "UPV4 attestation verifier mismatch"
  );
  const methods = pins.paymentMethods.map(ethers.utils.id);
  requireState(
    ordered(await verifier.getPaymentMethods(), methods),
    "UPV4 method order mismatch"
  );
  requireState(
    same(await nullifier.legacyNullifierRegistry(), legacyRecord.address),
    "Legacy nullifier registry mismatch"
  );
  requireState(
    ordered(await nullifier.getWriters(), [verifierRecord.address]),
    "NullifierRegistryV2 writers mismatch"
  );
  requireState(
    (await attestation.requiredSignatures()).toString() === "1",
    "Attestation threshold mismatch"
  );
  requireState(
    ordered(await attestation.witnesses(), expected.attestationWitnesses),
    "Attestation witnesses mismatch"
  );
  requireState(
    await orchestrators.isOrchestrator(expected.orchestrator),
    "Orchestrator is not registered"
  );
  requireState(!(await orchestrator.paused()), "Orchestrator is paused");
  requireState(
    (await orchestrator.chainId()).toString() === "8453",
    "Orchestrator chain id mismatch"
  );
  requireState(
    same(
      await orchestrator.paymentVerifierRegistry(),
      pins.paymentVerifierRegistry.address
    ),
    "Payment registry target mismatch"
  );
  requireState(
    ordered(await registry.getPaymentMethods(), methods),
    "Payment registry method order mismatch"
  );
  for (const name of pins.paymentMethods) {
    const method = ethers.utils.id(name);
    requireState(
      ordered(
        await registry.getCurrencies(method),
        expectedPaymentMethodCurrencies(name).map(ethers.utils.id)
      ),
      `Payment currencies mismatch: ${name}`
    );
    requireState(
      same(await registry.getVerifier(method), verifierRecord.address),
      `Payment verifier route mismatch: ${name}`
    );
  }
  requireState(
    (await legacy.getWriters()).length === 0,
    "Retired legacy nullifier writers remain"
  );
}
