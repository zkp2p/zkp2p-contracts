import * as assert from "node:assert/strict";
import { Contract, ContractFactory, utils } from "ethers";
import type { ContractTransaction, providers } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { ArtifactData, DeployFunction, Deployment } from "hardhat-deploy/types";
import type {
  NullifierRegistry, NullifierRegistryV2, PaymentVerifierRegistry, UnifiedPaymentVerifierV3, UnifiedPaymentVerifierV4,
} from "../typechain";
import { waitForDeploymentDelay } from "../deployments/helpers";
import { UPV4_BASE_RELEASE } from "../deployments/parameters";
import {
  baseCutoverConfig, buildUpv4SafeCalls, encodeUpv4SafeCall, Upv4CutoverConfig, Upv4SafeBatchKind,
} from "../deployments/upv4BaseCutover";

export const TAG = "47_deploy_unified_payment_verifier_v4";
export const DEPLOYMENT_NAME = "UnifiedPaymentVerifierV4";

const PINS = UPV4_BASE_RELEASE;

interface VerifierBindings {
  orchestratorRegistry: string;
  nullifierRegistry: string;
  attestationVerifier: string;
}

interface CatalogSnapshot {
  methods: string[];
  currencies: string[][];
  verifiers: string[];
}

interface Upv4Snapshot extends VerifierBindings {
  address: string;
  code: string;
  owner: string;
  domainSeparator: string;
  methods: string[];
}

const lower = (value: string): string => value.toLowerCase();
const same = (left: string, right: string): boolean => lower(left) === lower(right);

function assertAddress(actual: string, expected: string, label: string): void {
  assert.equal(lower(actual), lower(expected), `${label} mismatch`);
}

function assertOrder(actual: readonly string[], expected: readonly string[], label: string): void {
  assert.deepEqual(actual.map(lower), expected.map(lower), `${label} mismatch`);
}

function assertBindings(snapshot: VerifierBindings, expected: VerifierBindings, label: string): void {
  for (const key of Object.keys(expected) as Array<keyof VerifierBindings>) {
    assertAddress(snapshot[key], expected[key], `${label} ${key}`);
  }
}

function baseBindings(): VerifierBindings {
  return {
    orchestratorRegistry: PINS.orchestratorRegistry,
    nullifierRegistry: PINS.nullifierRegistryV2,
    attestationVerifier: PINS.multiAttestationVerifier,
  };
}

/** Only append to a known prefix so a resumed run cannot silently reorder payment methods. */
export function assertUpv4Snapshot(
  snapshot: Upv4Snapshot, bindings: VerifierBindings, methods: string[],
  chainId: number, deployer: string, governance: string,
): void {
  assert.notEqual(snapshot.code, "0x", "UnifiedPaymentVerifierV4 has no runtime code");
  assertBindings(snapshot, bindings, DEPLOYMENT_NAME);
  const domain = utils.keccak256(utils.defaultAbiCoder.encode(
    ["bytes32", "bytes32", "bytes32", "uint256", "address"],
    [utils.id("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      utils.id("UnifiedPaymentVerifier"), utils.id("1"), chainId, snapshot.address],
  ));
  assert.equal(snapshot.domainSeparator, domain, "UnifiedPaymentVerifierV4 DOMAIN_SEPARATOR mismatch");
  assert.ok(same(snapshot.owner, deployer) || same(snapshot.owner, governance), "UnifiedPaymentVerifierV4 owner mismatch");
  assertOrder(snapshot.methods, methods.slice(0, snapshot.methods.length), "UPV4 catalog ordered prefix");
  if (!same(deployer, governance) && same(snapshot.owner, governance)) {
    assertOrder(snapshot.methods, methods, "Safe-owned UPV4 catalog");
  }
}

function assertCatalog(catalog: CatalogSnapshot, config: Upv4CutoverConfig, verifier: string): void {
  assertOrder(catalog.methods, config.routes.map((route) => route.method), "PVR method order");
  config.routes.forEach((route, index) => {
    assertOrder(catalog.currencies[index], route.currencies, `PVR currencies ${route.method}`);
    assertAddress(catalog.verifiers[index], verifier, `PVR route ${route.method}`);
  });
}

async function readCatalog(registry: PaymentVerifierRegistry, blockTag: number): Promise<CatalogSnapshot> {
  const methods = await registry.getPaymentMethods({ blockTag });
  const routes = await Promise.all(methods.map(async (method) => ({
    currencies: await registry.getCurrencies(method, { blockTag }),
    verifier: await registry.getVerifier(method, { blockTag }),
  })));
  return { methods, currencies: routes.map((route) => route.currencies), verifiers: routes.map((route) => route.verifier) };
}

async function readBindings(
  verifier: UnifiedPaymentVerifierV3 | UnifiedPaymentVerifierV4, blockTag: number,
): Promise<VerifierBindings> {
  return {
    orchestratorRegistry: await verifier.orchestratorRegistry({ blockTag }),
    nullifierRegistry: await verifier.nullifierRegistry({ blockTag }),
    attestationVerifier: await verifier.attestationVerifier({ blockTag }),
  };
}

async function readUpv4(
  hre: HardhatRuntimeEnvironment, address: string, blockTag: number,
): Promise<Upv4Snapshot> {
  const code = await hre.ethers.provider.getCode(address, blockTag);
  assert.notEqual(code, "0x", "UnifiedPaymentVerifierV4 has no runtime code");
  const verifier = await hre.ethers.getContractAt(DEPLOYMENT_NAME, address) as UnifiedPaymentVerifierV4;
  return {
    address, code, ...await readBindings(verifier, blockTag),
    owner: await verifier.owner({ blockTag }), domainSeparator: await verifier.DOMAIN_SEPARATOR({ blockTag }),
    methods: await verifier.getPaymentMethods({ blockTag }),
  };
}

/** Exact creation input binds the artifact and constructor arguments to the mined deployment. */
export function assertPinnedUpv4Transaction(
  transaction: providers.TransactionResponse | null, artifact: ArtifactData, args: string[],
): void {
  assert.ok(transaction, "UPV4 deployment transaction missing");
  assertAddress(transaction.from, PINS.deployer, "UPV4 deployment transaction from");
  assert.equal(transaction.to, null, "UPV4 deployment transaction must be contract creation (to=null)");
  assert.equal(transaction.nonce, PINS.deployment.deployerNonce, "UPV4 deployment nonce mismatch");
  const expected = new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args).data;
  assert.ok(typeof expected === "string", "UPV4 artifact creation input missing");
  assert.equal(lower(transaction.data), lower(expected), "UPV4 creation input mismatch");
}

export function assertPinnedUpv4Receipt(receipt: providers.TransactionReceipt | null): asserts receipt is providers.TransactionReceipt {
  assert.ok(receipt, "UPV4 deployment receipt missing");
  assert.equal(receipt.status, 1, "UPV4 deployment receipt status mismatch");
  assertAddress(receipt.contractAddress, PINS.unifiedPaymentVerifierV4, "UPV4 deployment receipt contractAddress");
  assert.equal(receipt.blockNumber, PINS.deployment.blockNumber, "UPV4 deployment receipt block mismatch");
  assertAddress(receipt.from, PINS.deployer, "UPV4 deployment receipt from");
}

/** Immutables differ from the artifact's placeholders; runtime length and CBOR metadata must match. */
export function assertPinnedUpv4Runtime(runtime: string, compiled: string): void {
  function metadata(code: string): string {
    assert.ok(/^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length >= 6, "UPV4 runtime code missing or malformed");
    const length = parseInt(code.slice(-4), 16) + 2;
    assert.ok(length > 2 && length <= (code.length - 2) / 2, "UPV4 runtime metadata length invalid");
    return lower(code.slice(-length * 2));
  }
  assert.equal(runtime.length, compiled.length, "UPV4 runtime length mismatch");
  assert.equal(metadata(runtime), metadata(compiled), "UPV4 runtime metadata mismatch");
}

export function assertPinnedUpv4Record(record: Deployment, artifact: ArtifactData, args: string[]): void {
  assertAddress(record.address, PINS.unifiedPaymentVerifierV4, "UPV4 record address");
  assert.equal(record.transactionHash, PINS.deployment.transactionHash, "UPV4 record transactionHash mismatch");
  assert.ok(Array.isArray(record.args), "UPV4 record args missing");
  assertOrder(record.args, args, "UPV4 record args");
  assert.ok(record.receipt?.from, "UPV4 record receipt.from missing");
  assertAddress(record.receipt.from, PINS.deployer, "UPV4 record receipt.from");
  assert.equal(record.deployedBytecode, artifact.deployedBytecode, "UPV4 record deployedBytecode mismatch");
}

/** Provider and deployment storage come from the injected HRE; this path never obtains an account. */
export async function verifyPinnedUpv4(hre: HardhatRuntimeEnvironment) {
  const { provider } = hre.ethers;
  assert.equal((await provider.getNetwork()).chainId, PINS.chainId, "Base chainId mismatch");
  const artifact = await hre.deployments.getExtendedArtifact(DEPLOYMENT_NAME);
  assert.ok(artifact.deployedBytecode, "UPV4 artifact runtime code missing");
  const args = [PINS.orchestratorRegistry, PINS.nullifierRegistryV2, PINS.multiAttestationVerifier];
  const record = await hre.deployments.getOrNull(DEPLOYMENT_NAME);
  if (record) assertPinnedUpv4Record(record, artifact, args);
  assertPinnedUpv4Transaction(await provider.getTransaction(PINS.deployment.transactionHash), artifact, args);
  const receipt = await provider.getTransactionReceipt(PINS.deployment.transactionHash);
  assertPinnedUpv4Receipt(receipt);
  const blockTag = await provider.getBlockNumber();
  assertPinnedUpv4Runtime(await provider.getCode(PINS.unifiedPaymentVerifierV4, blockTag), artifact.deployedBytecode);
  // Construct with the provider explicitly: HRE's default getContractAt may obtain an account.
  const verifier = new Contract(PINS.unifiedPaymentVerifierV4, artifact.abi, provider) as UnifiedPaymentVerifierV4;
  assertBindings(await readBindings(verifier, blockTag), baseBindings(), DEPLOYMENT_NAME);
  const domain = utils._TypedDataEncoder.hashDomain({
    name: "UnifiedPaymentVerifier", version: "1", chainId: PINS.chainId, verifyingContract: PINS.unifiedPaymentVerifierV4,
  });
  assert.equal(await verifier.DOMAIN_SEPARATOR({ blockTag }), domain, "UnifiedPaymentVerifierV4 DOMAIN_SEPARATOR mismatch");
  assertAddress(await verifier.owner({ blockTag }), PINS.safe, "UPV4 owner");
  assertOrder(await verifier.getPaymentMethods({ blockTag }), baseCutoverConfig().routes.map((route) => route.method), "UPV4 catalog");
  return { artifact, args, receipt, record };
}

async function transact(hre: HardhatRuntimeEnvironment, transaction: Promise<ContractTransaction>): Promise<number> {
  const receipt = await (await transaction).wait();
  await waitForDeploymentDelay(hre);
  return receipt.blockNumber;
}

async function populateVerifier(
  hre: HardhatRuntimeEnvironment, record: Deployment | null, snapshot: Upv4Snapshot | null,
  config: Upv4CutoverConfig, bindings: VerifierBindings, deployer: string, blockTag: number,
): Promise<{ record: Deployment; snapshot: Upv4Snapshot }> {
  if (!record) {
    record = await hre.deployments.deploy(DEPLOYMENT_NAME, {
      contract: DEPLOYMENT_NAME, from: deployer,
      args: [bindings.orchestratorRegistry, bindings.nullifierRegistry, bindings.attestationVerifier], log: true,
    });
    await waitForDeploymentDelay(hre);
    assert.ok(record.receipt?.blockNumber !== undefined, "UPV4 deployment receipt block is missing");
    blockTag = record.receipt.blockNumber;
    snapshot = await readUpv4(hre, record.address, blockTag);
    assertUpv4Snapshot(snapshot, bindings, config.routes.map((route) => route.method), config.chainId, deployer, config.safe);
    assertAddress(snapshot.owner, deployer, "Fresh UPV4 owner");
  }
  assert.ok(snapshot, "UPV4 snapshot is missing");
  const signer = await hre.ethers.getSigner(deployer);
  const verifier = await hre.ethers.getContractAt(DEPLOYMENT_NAME, record.address, signer) as UnifiedPaymentVerifierV4;
  for (const route of config.routes.slice(snapshot.methods.length)) {
    blockTag = await transact(hre, verifier.addPaymentMethod(route.method));
  }
  if (!same(config.safe, deployer) && same(snapshot.owner, deployer)) {
    blockTag = await transact(hre, verifier.transferOwnership(config.safe));
  }
  snapshot = await readUpv4(hre, record.address, blockTag);
  assertUpv4Snapshot(snapshot, bindings, config.routes.map((route) => route.method), config.chainId, deployer, config.safe);
  assertAddress(snapshot.owner, config.safe, "UPV4 final owner");
  assertOrder(snapshot.methods, config.routes.map((route) => route.method), "UPV4 final catalog");
  return { record, snapshot };
}

enum LocalRouteState { Cutover, Active }

function localRouteState(catalog: CatalogSnapshot, writers: string[], upv3: string, upv4?: string): LocalRouteState {
  assert.ok(catalog.methods.length > 0, "PVR routes are empty");
  if (catalog.verifiers.every((verifier) => same(verifier, upv3))) {
    assertOrder(writers, [upv3], "Local pre-cutover writers");
    return LocalRouteState.Cutover;
  }
  assert.ok(upv4 && catalog.verifiers.every((verifier) => same(verifier, upv4)), "Local mixed or unknown routes");
  assertOrder([...writers].map(lower).sort(), [upv3, upv4].map(lower).sort(), "Local active writers");
  return LocalRouteState.Active;
}

async function deployLocal(hre: HardhatRuntimeEnvironment): Promise<void> {
  const blockTag = await hre.ethers.provider.getBlockNumber();
  const [deployer] = await hre.getUnnamedAccounts();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const records = await Promise.all([
    "OrchestratorRegistry", "NullifierRegistryV2", "MultiAttestationVerifier", "PaymentVerifierRegistry", "UnifiedPaymentVerifierV3",
  ].map((name) => hre.deployments.get(name)));
  const [orchestrators, nullifiers, mav, registry, upv3] = records;
  const pvr = await hre.ethers.getContractAt("PaymentVerifierRegistry", registry.address) as PaymentVerifierRegistry;
  const nrv2 = await hre.ethers.getContractAt("NullifierRegistryV2", nullifiers.address) as NullifierRegistryV2;
  const catalog = await readCatalog(pvr, blockTag);
  const config: Upv4CutoverConfig = {
    chainId, safe: deployer, paymentVerifierRegistry: registry.address,
    nullifierRegistryV2: nullifiers.address, unifiedPaymentVerifierV3: upv3.address,
    routes: catalog.methods.map((method, index) => ({ method, currencies: catalog.currencies[index] })),
  };
  const bindings = { orchestratorRegistry: orchestrators.address, nullifierRegistry: nullifiers.address, attestationVerifier: mav.address };
  const record = await hre.deployments.getOrNull(DEPLOYMENT_NAME);
  const routeState = localRouteState(catalog, await nrv2.getWriters({ blockTag }), upv3.address, record?.address);
  const snapshot = record ? await readUpv4(hre, record.address, blockTag) : null;
  if (snapshot) assertUpv4Snapshot(snapshot, bindings, catalog.methods, chainId, deployer, deployer);
  const populated = await populateVerifier(hre, record, snapshot, config, bindings, deployer, blockTag);
  if (routeState === LocalRouteState.Cutover) {
    const signer = await hre.ethers.getSigner(deployer);
    // UPV3 remains a writer so the prebuilt rollback can still nullify in the same replay domain.
    for (const call of buildUpv4SafeCalls(Upv4SafeBatchKind.Cutover, config, populated.record.address)) {
      await transact(hre, signer.sendTransaction(encodeUpv4SafeCall(call)));
    }
  }
  const finalBlock = await hre.ethers.provider.getBlockNumber();
  assertCatalog(await readCatalog(pvr, finalBlock), config, populated.record.address);
  localRouteState(await readCatalog(pvr, finalBlock), await nrv2.getWriters({ blockTag: finalBlock }), upv3.address, populated.record.address);
}

export function assertUpv4RoutesActive(
  catalog: CatalogSnapshot, upv4Methods: string[], writers: string[], legacyWriters: string[], upv3: string, upv4: string,
): boolean {
  assert.ok(catalog.methods.length > 0, "PVR routes are empty");
  if (catalog.verifiers.every((verifier) => same(verifier, upv3))) return false;
  assert.ok(catalog.verifiers.every((verifier) => same(verifier, upv4)), "Mixed or unknown UPV4 routes");
  assertOrder(upv4Methods, catalog.methods, "UPV4 catalog method order");
  assert.ok(writers.some((writer) => same(writer, upv4)) && writers.every((writer) => same(writer, upv3) || same(writer, upv4)),
    "UPV4 active writers mismatch");
  assert.equal(legacyWriters.length, 0, "Legacy nullifier writers remain");
  return true;
}

export async function upv4RoutesActive(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  const record = await hre.deployments.getOrNull(DEPLOYMENT_NAME);
  if (!record) return false;
  const blockTag = await hre.ethers.provider.getBlockNumber();
  const upv3 = await hre.deployments.get("UnifiedPaymentVerifierV3");
  const pvr = await hre.ethers.getContractAt("PaymentVerifierRegistry", (await hre.deployments.get("PaymentVerifierRegistry")).address) as PaymentVerifierRegistry;
  const catalog = await readCatalog(pvr, blockTag);
  if (catalog.methods.length > 0 && catalog.verifiers.every((verifier) => same(verifier, upv3.address))) return false;
  const upv4 = await hre.ethers.getContractAt(DEPLOYMENT_NAME, record.address) as UnifiedPaymentVerifierV4;
  const nrv2 = await hre.ethers.getContractAt("NullifierRegistryV2", (await hre.deployments.get("NullifierRegistryV2")).address) as NullifierRegistryV2;
  const legacyRecord = await hre.deployments.getOrNull("NullifierRegistry");
  const legacy = legacyRecord ? await hre.ethers.getContractAt("NullifierRegistry", legacyRecord.address) as NullifierRegistry : null;
  return assertUpv4RoutesActive(catalog, await upv4.getPaymentMethods({ blockTag }), await nrv2.getWriters({ blockTag }),
    legacy ? await legacy.getWriters({ blockTag }) : [], upv3.address, record.address);
}

export function createUpv4DeploymentLane(): DeployFunction {
  const func: DeployFunction = async (hre) => {
    const network = hre.deployments.getNetworkName();
    if (network === "localhost" || network === "hardhat") return deployLocal(hre);
    if (network !== "base") return;
    assert.equal(process.env.DEPLOY_ACTIVE_TAG, TAG, `Lane 47 requires DEPLOY_ACTIVE_TAG=${TAG}`);
    const { artifact, args, receipt, record } = await verifyPinnedUpv4(hre);
    if (record) return;
    await hre.deployments.save(DEPLOYMENT_NAME, {
      ...artifact, address: PINS.unifiedPaymentVerifierV4, args,
      transactionHash: PINS.deployment.transactionHash, receipt,
    });
    await verifyPinnedUpv4(hre);
  };
  func.skip = async (hre) => {
    const network = hre.deployments.getNetworkName();
    if (network === "localhost" || network === "hardhat") return false;
    if (network !== "base") return true;
    if (await hre.deployments.getOrNull(DEPLOYMENT_NAME)) {
      await verifyPinnedUpv4(hre);
      return true;
    }
    if (process.env.DEPLOY_ACTIVE_TAG === TAG) return false;
    throw new Error("UnifiedPaymentVerifierV4 record missing; run the tagged lane-47 adoption");
  };
  func.tags = [TAG, DEPLOYMENT_NAME];
  return func;
}

export default createUpv4DeploymentLane();
