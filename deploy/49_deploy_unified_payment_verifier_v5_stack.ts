import * as assert from "node:assert/strict";
import { Contract, constants, utils } from "ethers";
import type { ContractTransaction, Signer } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";
import { assertDeploymentMatchesChain } from "../deployments/canonicalDeployment";
import { waitForDeploymentDelay } from "../deployments/helpers";
import {
  UPV5_DEPLOYMENT_NAMES, Upv5DeploymentName, Upv5Network, Upv5ReleasePins, parseUpv5Network, sameAddress,
  upv5ReleasePins,
} from "../deployments/upv5Cutover";
import { RETIRED_DEPLOYERS } from "../utils/deployerKeys";

export const TAG = "49_deploy_unified_payment_verifier_v5_stack";
export const LIVE_FLAGS: Record<Upv5Network, string> = {
  [Upv5Network.BaseStaging]: "ENABLE_STAGING_UPV5_STACK_DEPLOYMENT",
  [Upv5Network.Base]: "ENABLE_BASE_UPV5_STACK_DEPLOYMENT",
};

const ABI = {
  verifier: [
    "function orchestratorRegistry() view returns (address)", "function nullifierRegistry() view returns (address)",
    "function attestationVerifier() view returns (address)", "function owner() view returns (address)",
    "function getPaymentMethods() view returns (bytes32[])", "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function addPaymentMethod(bytes32)", "function transferOwnership(address)",
  ],
  nullifierRegistry: [
    "function predecessor() view returns (address)", "function getWriters() view returns (address[])",
    "function owner() view returns (address)", "function transferOwnership(address)",
  ],
  disputeVerifier: [
    "function nullifierRegistry() view returns (address)", "function attestationVerifier() view returns (address)",
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
    "function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])",
  ],
  policy: ["function disputeVerifier() view returns (address)"],
  registry: ["function getPaymentMethods() view returns (bytes32[])", "function getVerifier(bytes32) view returns (address)"],
};

export interface Upv5StackBindings {
  orchestratorRegistry: string;
  nullifierRegistryV2: string;
  attestationVerifier: string;
  disputeAttestationVerifier: string;
  upv4Methods: string[];
}

export interface Upv5StackSnapshot {
  nullifierRegistryV3: { address: string; predecessor: string; writers: string[]; owner: string };
  unifiedPaymentVerifierV5: {
    address: string; orchestratorRegistry: string; nullifierRegistry: string; attestationVerifier: string;
    attestationVerifierDeployed: boolean; owner: string; methods: string[]; domainSeparator: string;
  };
  disputeVerifierV2: {
    address: string; nullifierRegistry: string; attestationVerifier: string; attestationVerifierDeployed: boolean;
    owner: string; pendingOwner: string;
    domainName: string; domainVersion: string; domainChainId: number; domainVerifyingContract: string;
  };
}

export enum Upv5OwnershipStage { Deployer, Handover }

/**
 * At deployment the attestation verifiers must be exactly the bindings just used. Afterwards governance may
 * legitimately rotate them with `setAttestationVerifier`, so routine re-verification only requires a deployed
 * contract.
 */
export enum Upv5AttestationCheck { Binding, Deployed }

interface LaneContext {
  network: string;
  chainId: number;
  deployer: string;
  governance: string;
  pins: Upv5ReleasePins | null;
}

const lower = (value: string): string => value.toLowerCase();

function liveNetwork(network: string): Upv5Network | null {
  return network === Upv5Network.Base || network === Upv5Network.BaseStaging ? parseUpv5Network(network) : null;
}

function isLocal(network: string): boolean {
  return network === "localhost" || network === "hardhat";
}

function assertAddress(actual: string, expected: string, label: string): void {
  assert.ok(sameAddress(actual, expected), `${label} is ${actual}, expected ${expected}`);
}

function readContract(hre: HardhatRuntimeEnvironment, address: string, abi: string[]): Contract {
  // Construct with the provider explicitly: HRE's getContractAt may obtain an account.
  return new Contract(address, abi, hre.ethers.provider);
}

/**
 * Reads the constructor inputs from the live predecessors rather than from configuration: UPV5 binds the
 * OrchestratorRegistry and attestation verifier UPV4 uses, V3 reads through UPV4's NullifierRegistryV2, and
 * DisputeVerifierV2 keeps the live DisputeVerifier's attestation verifier. On Base and Base staging every
 * record and every live read must equal the release pins.
 */
export async function readUpv5StackBindings(
  hre: HardhatRuntimeEnvironment, pins: Upv5ReleasePins | null, blockTag: number,
): Promise<Upv5StackBindings> {
  const record = async (name: string): Promise<string> => (await hre.deployments.get(name)).address;
  const upv4Address = await record("UnifiedPaymentVerifierV4");
  const records = {
    orchestratorRegistry: await record("OrchestratorRegistry"),
    nullifierRegistryV2: await record("NullifierRegistryV2"),
    multiAttestationVerifier: await record("MultiAttestationVerifier"),
    disputeVerifier: await record("DisputeVerifier"),
  };
  if (pins) {
    assertAddress(upv4Address, pins.unifiedPaymentVerifierV4, "UnifiedPaymentVerifierV4 record");
    assertAddress(records.orchestratorRegistry, pins.orchestratorRegistry, "OrchestratorRegistry record");
    assertAddress(records.nullifierRegistryV2, pins.nullifierRegistryV2, "NullifierRegistryV2 record");
    assertAddress(records.multiAttestationVerifier, pins.multiAttestationVerifier, "MultiAttestationVerifier record");
    assertAddress(records.disputeVerifier, pins.disputeVerifier, "DisputeVerifier record");
    assertAddress(await record("DisputeProtectionPolicyV2"), pins.disputeProtectionPolicyV2, "DisputeProtectionPolicyV2 record");
  }
  const options = { blockTag };
  const upv4 = readContract(hre, upv4Address, ABI.verifier);
  const orchestratorRegistry: string = await upv4.orchestratorRegistry(options);
  const nullifierRegistryV2: string = await upv4.nullifierRegistry(options);
  const attestationVerifier: string = await upv4.attestationVerifier(options);
  const bindings = { orchestratorRegistry, nullifierRegistryV2, attestationVerifier };
  assertAddress(bindings.orchestratorRegistry, records.orchestratorRegistry, "UPV4 orchestratorRegistry");
  assertAddress(bindings.nullifierRegistryV2, records.nullifierRegistryV2, "UPV4 nullifierRegistry");
  assertAddress(bindings.attestationVerifier, records.multiAttestationVerifier, "UPV4 attestationVerifier");
  const upv4Methods: string[] = await upv4.getPaymentMethods(options);
  assert.ok(upv4Methods.length > 0, "UPV4 has no payment methods");

  const disputeVerifier = readContract(hre, records.disputeVerifier, ABI.disputeVerifier);
  assertAddress(await disputeVerifier.nullifierRegistry(options), records.nullifierRegistryV2, "DisputeVerifier nullifierRegistry");
  const disputeAttestationVerifier: string = await disputeVerifier.attestationVerifier(options);
  if (pins) {
    assertAddress(disputeAttestationVerifier, pins.disputeAttestationVerifier, "DisputeVerifier attestationVerifier");
    const policy = readContract(hre, pins.disputeProtectionPolicyV2, ABI.policy);
    const selected: string = await policy.disputeVerifier(options);
    const successor = await hre.deployments.getOrNull(Upv5DeploymentName.DisputeVerifierV2);
    assert.ok(sameAddress(selected, pins.disputeVerifier) || (successor !== null && sameAddress(selected, successor.address)),
      `DisputeProtectionPolicyV2 selects unknown dispute verifier ${selected}`);
  }
  return { ...bindings, disputeAttestationVerifier, upv4Methods };
}

export async function readUpv5Stack(
  hre: HardhatRuntimeEnvironment, records: Record<Upv5DeploymentName, Deployment>, blockTag: number,
): Promise<Upv5StackSnapshot> {
  const options = { blockTag };
  const v3 = readContract(hre, records.NullifierRegistryV3.address, ABI.nullifierRegistry);
  const upv5 = readContract(hre, records.UnifiedPaymentVerifierV5.address, ABI.verifier);
  const dv2 = readContract(hre, records.DisputeVerifierV2.address, ABI.disputeVerifier);
  const [, domainName, domainVersion, domainChainId, domainVerifyingContract] = await dv2.eip712Domain(options);
  const deployed = async (address: string): Promise<boolean> =>
    !sameAddress(address, constants.AddressZero) && (await hre.ethers.provider.getCode(address, blockTag)) !== "0x";
  const upv5AttestationVerifier: string = await upv5.attestationVerifier(options);
  const dv2AttestationVerifier: string = await dv2.attestationVerifier(options);
  return {
    nullifierRegistryV3: {
      address: v3.address, predecessor: await v3.predecessor(options), writers: await v3.getWriters(options),
      owner: await v3.owner(options),
    },
    unifiedPaymentVerifierV5: {
      address: upv5.address, orchestratorRegistry: await upv5.orchestratorRegistry(options),
      nullifierRegistry: await upv5.nullifierRegistry(options), attestationVerifier: upv5AttestationVerifier,
      attestationVerifierDeployed: await deployed(upv5AttestationVerifier),
      owner: await upv5.owner(options), methods: await upv5.getPaymentMethods(options),
      domainSeparator: await upv5.DOMAIN_SEPARATOR(options),
    },
    disputeVerifierV2: {
      address: dv2.address, nullifierRegistry: await dv2.nullifierRegistry(options),
      attestationVerifier: dv2AttestationVerifier, attestationVerifierDeployed: await deployed(dv2AttestationVerifier),
      owner: await dv2.owner(options),
      pendingOwner: await dv2.pendingOwner(options), domainName, domainVersion,
      domainChainId: Number(domainChainId), domainVerifyingContract,
    },
  };
}

/**
 * Bindings never change after deployment; ownership is checked against where the lane has got to. After the
 * handover UPV5 must support `requiredMethods`: UPV4's catalog when the lane has just copied it, and only the
 * methods actually routed to UPV5 when an untagged run re-verifies, so later retirements never break it.
 */
export function assertUpv5Stack(
  snapshot: Upv5StackSnapshot, bindings: Upv5StackBindings, chainId: number,
  deployer: string, governance: string, stage: Upv5OwnershipStage, requiredMethods: string[] = [],
  attestation: Upv5AttestationCheck = Upv5AttestationCheck.Binding,
): void {
  const { nullifierRegistryV3: v3, unifiedPaymentVerifierV5: upv5, disputeVerifierV2: dv2 } = snapshot;
  assertAddress(v3.predecessor, bindings.nullifierRegistryV2, "NullifierRegistryV3 predecessor");
  assert.ok(v3.writers.every((writer) => sameAddress(writer, upv5.address)),
    `NullifierRegistryV3 has a writer other than UPV5: [${v3.writers.join(", ")}]`);
  assertAddress(upv5.orchestratorRegistry, bindings.orchestratorRegistry, "UPV5 orchestratorRegistry");
  assertAddress(upv5.nullifierRegistry, v3.address, "UPV5 nullifierRegistry");
  if (attestation === Upv5AttestationCheck.Binding) {
    assertAddress(upv5.attestationVerifier, bindings.attestationVerifier, "UPV5 attestationVerifier");
    assertAddress(dv2.attestationVerifier, bindings.disputeAttestationVerifier, "DisputeVerifierV2 attestationVerifier");
  }
  assert.ok(upv5.attestationVerifierDeployed, `UPV5 attestationVerifier ${upv5.attestationVerifier} is not a deployed contract`);
  assert.ok(dv2.attestationVerifierDeployed,
    `DisputeVerifierV2 attestationVerifier ${dv2.attestationVerifier} is not a deployed contract`);
  assert.equal(upv5.domainSeparator, utils._TypedDataEncoder.hashDomain({
    name: "UnifiedPaymentVerifier", version: "1", chainId, verifyingContract: upv5.address,
  }), "UPV5 DOMAIN_SEPARATOR mismatch");
  assertAddress(dv2.nullifierRegistry, v3.address, "DisputeVerifierV2 nullifierRegistry");
  assert.deepEqual([dv2.domainName, dv2.domainVersion, dv2.domainChainId], ["ZKP2P DisputeVerifier", "1", chainId],
    "DisputeVerifierV2 EIP-712 domain mismatch");
  assertAddress(dv2.domainVerifyingContract, dv2.address, "DisputeVerifierV2 EIP-712 verifyingContract");

  // DisputeVerifierV2 is constructed owned by governance, so it has no handover and nothing to accept.
  assertAddress(dv2.owner, governance, "DisputeVerifierV2 owner");
  assertAddress(dv2.pendingOwner, constants.AddressZero, "DisputeVerifierV2 pendingOwner");
  const owners = [v3.owner, upv5.owner];
  if (stage === Upv5OwnershipStage.Deployer) {
    assert.ok(owners.every((owner) => sameAddress(owner, deployer) || sameAddress(owner, governance)),
      `UPV5 stack owner is neither deployer nor governance: [${owners.join(", ")}]`);
    return;
  }
  const missing = requiredMethods.filter((method) => !upv5.methods.some((candidate) => lower(candidate) === lower(method)));
  assert.equal(missing.length, 0, `UPV5 lacks payment methods: [${missing.join(", ")}]`);
  assertAddress(v3.owner, governance, "NullifierRegistryV3 owner");
  assertAddress(upv5.owner, governance, "UPV5 owner");
}

async function stackRecords(hre: HardhatRuntimeEnvironment): Promise<Record<Upv5DeploymentName, Deployment> | null> {
  const found = await Promise.all(UPV5_DEPLOYMENT_NAMES.map((name) => hre.deployments.getOrNull(name)));
  if (found.every((record) => record === null)) return null;
  const [NullifierRegistryV3, UnifiedPaymentVerifierV5, DisputeVerifierV2] = found;
  if (!NullifierRegistryV3 || !UnifiedPaymentVerifierV5 || !DisputeVerifierV2) {
    const missing = UPV5_DEPLOYMENT_NAMES.filter((_, index) => found[index] === null);
    throw new Error(`UPV5 stack records incomplete (missing ${missing.join(", ")}); resume with DEPLOY_ACTIVE_TAG=${TAG}`);
  }
  return { NullifierRegistryV3, UnifiedPaymentVerifierV5, DisputeVerifierV2 };
}

function expectedArgs(name: Upv5DeploymentName, bindings: Upv5StackBindings, governance: string,
  nullifierRegistryV3: string): string[] {
  if (name === Upv5DeploymentName.NullifierRegistryV3) return [bindings.nullifierRegistryV2];
  if (name === Upv5DeploymentName.UnifiedPaymentVerifierV5) {
    return [bindings.orchestratorRegistry, nullifierRegistryV3, bindings.attestationVerifier];
  }
  return [governance, nullifierRegistryV3, bindings.disputeAttestationVerifier];
}

async function transact(hre: HardhatRuntimeEnvironment, transaction: Promise<ContractTransaction>): Promise<number> {
  const receipt = await (await transaction).wait();
  assert.equal(receipt.status, 1, `transaction ${receipt.transactionHash} reverted`);
  await waitForDeploymentDelay(hre);
  return receipt.blockNumber;
}

async function deployOrResume(
  hre: HardhatRuntimeEnvironment, name: Upv5DeploymentName, args: string[], deployer: string,
): Promise<Deployment> {
  const existing = await hre.deployments.getOrNull(name);
  if (existing) {
    assert.ok(Array.isArray(existing.args), `${name} record args missing`);
    assert.deepEqual(existing.args.map((arg: unknown) => lower(String(arg))), args.map(lower), `${name} record args mismatch`);
    return existing;
  }
  const record = await hre.deployments.deploy(name, { contract: name, from: deployer, args, log: true });
  await waitForDeploymentDelay(hre);
  return record;
}

async function deployStack(hre: HardhatRuntimeEnvironment, context: LaneContext): Promise<void> {
  const { deployer, governance, chainId } = context;
  let blockTag = await hre.ethers.provider.getBlockNumber();
  const bindings = await readUpv5StackBindings(hre, context.pins, blockTag);
  const v3 = await deployOrResume(hre, Upv5DeploymentName.NullifierRegistryV3,
    expectedArgs(Upv5DeploymentName.NullifierRegistryV3, bindings, governance, ""), deployer);
  const upv5 = await deployOrResume(hre, Upv5DeploymentName.UnifiedPaymentVerifierV5,
    expectedArgs(Upv5DeploymentName.UnifiedPaymentVerifierV5, bindings, governance, v3.address), deployer);
  const dv2 = await deployOrResume(hre, Upv5DeploymentName.DisputeVerifierV2,
    expectedArgs(Upv5DeploymentName.DisputeVerifierV2, bindings, governance, v3.address), deployer);
  const records = { NullifierRegistryV3: v3, UnifiedPaymentVerifierV5: upv5, DisputeVerifierV2: dv2 };

  blockTag = await hre.ethers.provider.getBlockNumber();
  let snapshot = await readUpv5Stack(hre, records, blockTag);
  assertUpv5Stack(snapshot, bindings, chainId, deployer, governance, Upv5OwnershipStage.Deployer);

  const signer: Signer = await hre.ethers.getSigner(deployer);
  const verifier = new Contract(upv5.address, ABI.verifier, signer);
  const missing = bindings.upv4Methods.filter((method) =>
    !snapshot.unifiedPaymentVerifierV5.methods.some((candidate) => lower(candidate) === lower(method)));
  if (missing.length > 0) {
    assertAddress(snapshot.unifiedPaymentVerifierV5.owner, deployer, "UPV5 owner while adding payment methods");
    for (const method of missing) await transact(hre, verifier.addPaymentMethod(method));
  }

  if (!sameAddress(governance, deployer)) {
    // NullifierRegistryV3 and UPV5 are single-step Ownable, so the transfer completes at once.
    if (sameAddress(snapshot.nullifierRegistryV3.owner, deployer)) {
      await transact(hre, new Contract(v3.address, ABI.nullifierRegistry, signer).transferOwnership(governance));
    }
    if (sameAddress(snapshot.unifiedPaymentVerifierV5.owner, deployer)) {
      await transact(hre, verifier.transferOwnership(governance));
    }
  }

  blockTag = await hre.ethers.provider.getBlockNumber();
  snapshot = await readUpv5Stack(hre, records, blockTag);
  assertUpv5Stack(snapshot, bindings, chainId, deployer, governance, Upv5OwnershipStage.Handover, bindings.upv4Methods);
  console.log(`UPV5 stack on ${context.network}: NullifierRegistryV3 ${v3.address}, UnifiedPaymentVerifierV5 ` +
    `${upv5.address} (${snapshot.unifiedPaymentVerifierV5.methods.length} methods), DisputeVerifierV2 ${dv2.address}. ` +
    "No route, writer or dispute policy changed; run the cutover separately.");
}

async function methodsRoutedTo(
  hre: HardhatRuntimeEnvironment, registryAddress: string, verifier: string, blockTag: number,
): Promise<string[]> {
  const registry = readContract(hre, registryAddress, ABI.registry);
  const methods: string[] = await registry.getPaymentMethods({ blockTag });
  const verifiers: string[] = await Promise.all(methods.map((method) => registry.getVerifier(method, { blockTag })));
  return methods.filter((_, index) => sameAddress(verifiers[index], verifier));
}

/**
 * Untagged live runs only re-read recorded deployments and never obtain an account. They check the bindings that
 * cannot change (V3's predecessor, UPV5's registries, DisputeVerifierV2's registry), governance ownership, and that
 * each attestation verifier is a deployed contract. They never compare a value governance may legitimately change
 * (an attestation verifier, the live UPV4 or old DisputeVerifier) with a pin.
 */
export async function verifyRecordedUpv5Stack(hre: HardhatRuntimeEnvironment, network: Upv5Network): Promise<boolean> {
  const records = await stackRecords(hre);
  if (!records) return false;
  const pins = upv5ReleasePins(network);
  const blockTag = await hre.ethers.provider.getBlockNumber();
  for (const name of UPV5_DEPLOYMENT_NAMES) {
    await assertDeploymentMatchesChain(hre, records[name], name, name, blockTag);
  }
  const bindings: Upv5StackBindings = {
    orchestratorRegistry: pins.orchestratorRegistry, nullifierRegistryV2: pins.nullifierRegistryV2,
    attestationVerifier: pins.multiAttestationVerifier, disputeAttestationVerifier: pins.disputeAttestationVerifier,
    upv4Methods: [],
  };
  for (const name of UPV5_DEPLOYMENT_NAMES) {
    const args = expectedArgs(name, bindings, pins.governance, records.NullifierRegistryV3.address);
    assert.deepEqual((records[name].args ?? []).map((arg: unknown) => lower(String(arg))), args.map(lower), `${name} record args mismatch`);
  }
  const routed = await methodsRoutedTo(hre, pins.paymentVerifierRegistry, records.UnifiedPaymentVerifierV5.address, blockTag);
  assertUpv5Stack(await readUpv5Stack(hre, records, blockTag), bindings, pins.chainId, pins.deployer, pins.governance,
    Upv5OwnershipStage.Handover, routed, Upv5AttestationCheck.Deployed);
  return true;
}

export interface Upv5RouteSurface {
  routedVerifiers: string[];
  upv5Methods: string[];
  registryMethods: string[];
  nullifierRegistryV2Writers: string[];
  nullifierRegistryV3Writers: string[];
  legacyNullifierWriters: string[];
}

/**
 * False while no route points at UPV5. Once any does, every route must, and the replay domains must be the
 * cutover's end state: NullifierRegistryV2 and the legacy registry write-locked, V3 written only by UPV5.
 */
export function assertUpv5RoutesActive(surface: Upv5RouteSurface, upv5: string): boolean {
  assert.ok(surface.routedVerifiers.length > 0, "PVR routes are empty");
  if (!surface.routedVerifiers.some((verifier) => sameAddress(verifier, upv5))) return false;
  assert.ok(surface.routedVerifiers.every((verifier) => sameAddress(verifier, upv5)), "Mixed or unknown UPV5 routes");
  const missing = surface.registryMethods.filter((method) => !surface.upv5Methods.some((candidate) => lower(candidate) === lower(method)));
  assert.equal(missing.length, 0, `UPV5 lacks routed payment methods: [${missing.join(", ")}]`);
  assert.equal(surface.nullifierRegistryV2Writers.length, 0, "NullifierRegistryV2 writers remain after the UPV5 cutover");
  assert.ok(surface.nullifierRegistryV3Writers.length === 1 && sameAddress(surface.nullifierRegistryV3Writers[0], upv5),
    "NullifierRegistryV3 writers must be exactly UPV5");
  assert.equal(surface.legacyNullifierWriters.length, 0, "Legacy nullifier writers remain");
  return true;
}

export async function upv5RoutesActive(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const record = await hre.deployments.getOrNull(Upv5DeploymentName.UnifiedPaymentVerifierV5);
  if (!record) return false;
  const v3Record = await hre.deployments.get(Upv5DeploymentName.NullifierRegistryV3);
  const blockTag = await hre.ethers.provider.getBlockNumber();
  const options = { blockTag };
  const registry = readContract(hre, (await hre.deployments.get("PaymentVerifierRegistry")).address, [
    "function getPaymentMethods() view returns (bytes32[])", "function getVerifier(bytes32) view returns (address)",
  ]);
  const registryMethods: string[] = await registry.getPaymentMethods(options);
  const routedVerifiers: string[] = await Promise.all(registryMethods.map((method) => registry.getVerifier(method, options)));
  if (registryMethods.length > 0 && !routedVerifiers.some((verifier) => sameAddress(verifier, record.address))) return false;
  const writers = async (address: string): Promise<string[]> =>
    readContract(hre, address, ABI.nullifierRegistry).getWriters(options);
  const legacy = await hre.deployments.getOrNull("NullifierRegistry");
  return assertUpv5RoutesActive({
    routedVerifiers, registryMethods,
    upv5Methods: await readContract(hre, record.address, ABI.verifier).getPaymentMethods(options),
    nullifierRegistryV2Writers: await writers((await hre.deployments.get("NullifierRegistryV2")).address),
    nullifierRegistryV3Writers: await writers(v3Record.address),
    legacyNullifierWriters: legacy ? await writers(legacy.address) : [],
  }, record.address);
}

async function liveContext(hre: HardhatRuntimeEnvironment, network: Upv5Network): Promise<LaneContext> {
  assert.equal(process.env.DEPLOY_ACTIVE_TAG, TAG, `Lane 49 requires DEPLOY_ACTIVE_TAG=${TAG}`);
  assert.equal(process.env[LIVE_FLAGS[network]], "true", `Lane 49 on ${network} requires ${LIVE_FLAGS[network]}=true`);
  const pins = upv5ReleasePins(network);
  assert.equal((await hre.ethers.provider.getNetwork()).chainId, pins.chainId, "Base chainId mismatch");
  const [deployer] = await hre.getUnnamedAccounts();
  assert.ok(deployer, `No deployer account configured for ${network}`);
  assert.ok(!RETIRED_DEPLOYERS.some((retired) => sameAddress(retired, deployer)), "Lane 49 refuses a retired deployer");
  assertAddress(deployer, pins.deployer, "Lane 49 deployer");
  return { network, chainId: pins.chainId, deployer, governance: pins.governance, pins };
}

async function localContext(hre: HardhatRuntimeEnvironment, network: string): Promise<LaneContext> {
  const [deployer] = await hre.getUnnamedAccounts();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  return { network, chainId, deployer, governance: deployer, pins: null };
}

export function createUpv5StackLane(): DeployFunction {
  const func: DeployFunction = async (hre) => {
    const network = hre.deployments.getNetworkName();
    // Local networks deploy the stack and leave UPV4 routed; the cutover is a separate, explicit step.
    if (isLocal(network)) return deployStack(hre, await localContext(hre, network));
    const live = liveNetwork(network);
    if (!live) return;
    await deployStack(hre, await liveContext(hre, live));
  };
  func.skip = async (hre) => {
    const network = hre.deployments.getNetworkName();
    if (isLocal(network)) return false;
    const live = liveNetwork(network);
    if (!live) return true;
    if (process.env.DEPLOY_ACTIVE_TAG === TAG) return false;
    if (process.env[LIVE_FLAGS[live]] !== undefined) {
      throw new Error(`${LIVE_FLAGS[live]} requires DEPLOY_ACTIVE_TAG=${TAG}`);
    }
    await verifyRecordedUpv5Stack(hre, live);
    return true;
  };
  func.tags = [TAG, "UnifiedPaymentVerifierV5Stack"];
  return func;
}

export default createUpv5StackLane();
