import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, resolve } from "node:path";
import { BigNumber, utils } from "ethers";
import type { ContractTransaction } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction, Deployment } from "hardhat-deploy/types";
import type {
  MultiAttestationVerifier, NullifierRegistry, NullifierRegistryV2, OrchestratorRegistry,
  OrchestratorV3, PaymentVerifierRegistry, UnifiedPaymentVerifierV3, UnifiedPaymentVerifierV4,
} from "../typechain";
import { waitForDeploymentDelay } from "../deployments/helpers";
import { UPV4_BASE_RELEASE } from "../deployments/parameters";
import { installSafeArtifactPair } from "../deployments/safeArtifacts";
import {
  assertUpv4SafeBatch, baseCutoverConfig, buildUpv4SafeCalls, decodeUpv4SafeBatch, encodeUpv4SafeCall,
  renderUpv4SafeBatch, serializeUpv4SafeBatch, serializeUpv4SafeBatchSidecar, UPV4_SAFE_BATCH_FILES,
  Upv4CutoverConfig, Upv4SafeBatch, Upv4SafeBatchKind,
} from "../deployments/upv4BaseCutover";

export const TAG = "47_deploy_unified_payment_verifier_v4";
export const LIVE_FLAG = "ENABLE_BASE_UPV4_DEPLOYMENT";
export const RELEASE_SHA_FLAG = "CONFIRM_BASE_UPV4_RELEASE_READY_SHA";
export const DEPLOYMENT_NAME = "UnifiedPaymentVerifierV4";

const ROOT = resolve(__dirname, "..");
const PINS = UPV4_BASE_RELEASE;
const RECORD_PINS = {
  OrchestratorRegistry: PINS.orchestratorRegistry,
  NullifierRegistryV2: PINS.nullifierRegistryV2,
  MultiAttestationVerifier: PINS.multiAttestationVerifier,
  PaymentVerifierRegistry: PINS.paymentVerifierRegistry,
  UnifiedPaymentVerifierV3: PINS.unifiedPaymentVerifierV3,
  OrchestratorV3: PINS.orchestratorV3,
};

interface LaneOptions {
  git?: (args: string[]) => string;
  artifactRoot?: string;
}

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

interface BaseSnapshot {
  owners: Record<string, string>;
  catalog: CatalogSnapshot;
  writers: string[];
  orchestratorRegistered: boolean;
  orchestratorPaymentRegistry: string;
  upv3: VerifierBindings;
  upv3Methods: string[];
  requiredSignatures: BigNumber;
  witnesses: string[];
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

function assertTaggedFlags(): void {
  if ([LIVE_FLAG, RELEASE_SHA_FLAG].some((flag) => process.env[flag] !== undefined) &&
    process.env.DEPLOY_ACTIVE_TAG !== TAG) {
    throw new Error(`Lane 47 flags require DEPLOY_ACTIVE_TAG=${TAG}`);
  }
}

export function assertReviewedSource(releaseSha: string | undefined, head: string, status: string): string {
  assert.ok(releaseSha && /^[0-9a-f]{40}$/.test(releaseSha), "release SHA must be 40 lowercase hex characters");
  assert.equal(head.trim(), releaseSha, "HEAD differs from release SHA");
  for (const entry of status.split("\n").filter(Boolean)) {
    const paths = entry.slice(3).split(" -> ").map((path) => path.startsWith('"') ? JSON.parse(path) as string : path);
    for (const path of paths) {
      const allowed = path === "deployments/base/UnifiedPaymentVerifierV4.json" ||
        path === "deployments/base/.migrations.json" || path.startsWith("deployments/base/solcInputs/") ||
        /^deployments\/outputs\/safe-batches\/(?:superseded\/)?base_upv4_[^/]+$/.test(path);
      assert.ok(allowed, `Unrelated dirty worktree path: ${path}`);
    }
  }
  return releaseSha;
}

/** Immutable addresses differ across deployments; compiler metadata binds the reviewed staging source. */
export function assertStagingSource(compiled: string, staging: string): void {
  const error = "UPV4 artifact differs from the reviewed staging source";
  function metadata(code: string): string {
    assert.ok(/^0x(?:[0-9a-fA-F]{2})+$/.test(code) && code.length >= 6, error);
    const length = parseInt(code.slice(-4), 16) + 2;
    assert.ok(length > 2 && length <= (code.length - 2) / 2, error);
    return code.slice(-length * 2).toLowerCase();
  }
  assert.equal(compiled.length, staging.length, error);
  assert.equal(metadata(compiled), metadata(staging), error);
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

export function assertBaseSnapshot(snapshot: BaseSnapshot): void {
  const config = baseCutoverConfig();
  for (const [name, owner] of Object.entries(snapshot.owners)) assertAddress(owner, PINS.safe, `${name} owner`);
  assertCatalog(snapshot.catalog, config, PINS.unifiedPaymentVerifierV3);
  assertOrder(snapshot.writers, [PINS.unifiedPaymentVerifierV3], "NullifierRegistryV2 writers");
  assert.ok(snapshot.orchestratorRegistered, "OrchestratorV3 is not registered");
  assertAddress(snapshot.orchestratorPaymentRegistry, PINS.paymentVerifierRegistry, "OrchestratorV3 payment registry");
  assertBindings(snapshot.upv3, baseBindings(), "UnifiedPaymentVerifierV3");
  assertOrder(snapshot.upv3Methods, config.routes.map((route) => route.method), "UnifiedPaymentVerifierV3 method order");
  assert.ok(snapshot.requiredSignatures.gte(1) && snapshot.requiredSignatures.lte(snapshot.witnesses.length),
    "MultiAttestationVerifier witness threshold mismatch");
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

async function readBaseSnapshot(hre: HardhatRuntimeEnvironment, blockTag: number): Promise<BaseSnapshot> {
  for (const [name, address] of Object.entries(RECORD_PINS)) {
    const record = await hre.deployments.getOrNull(name);
    assert.ok(record, `${name} deployment is missing`);
    assertAddress(record.address, address, `${name} record address`);
    assert.notEqual(await hre.ethers.provider.getCode(address, blockTag), "0x", `${name} has no runtime code`);
  }
  const registry = await hre.ethers.getContractAt("PaymentVerifierRegistry", PINS.paymentVerifierRegistry) as PaymentVerifierRegistry;
  const nullifiers = await hre.ethers.getContractAt("NullifierRegistryV2", PINS.nullifierRegistryV2) as NullifierRegistryV2;
  const orchestrators = await hre.ethers.getContractAt("OrchestratorRegistry", PINS.orchestratorRegistry) as OrchestratorRegistry;
  const upv3 = await hre.ethers.getContractAt("UnifiedPaymentVerifierV3", PINS.unifiedPaymentVerifierV3) as UnifiedPaymentVerifierV3;
  const mav = await hre.ethers.getContractAt("MultiAttestationVerifier", PINS.multiAttestationVerifier) as MultiAttestationVerifier;
  const orchestrator = await hre.ethers.getContractAt("OrchestratorV3", PINS.orchestratorV3) as OrchestratorV3;
  return {
    owners: {
      PaymentVerifierRegistry: await registry.owner({ blockTag }), NullifierRegistryV2: await nullifiers.owner({ blockTag }),
      OrchestratorRegistry: await orchestrators.owner({ blockTag }), UnifiedPaymentVerifierV3: await upv3.owner({ blockTag }),
      MultiAttestationVerifier: await mav.owner({ blockTag }),
    },
    catalog: await readCatalog(registry, blockTag), writers: await nullifiers.getWriters({ blockTag }),
    orchestratorRegistered: await orchestrators.isOrchestrator(PINS.orchestratorV3, { blockTag }),
    orchestratorPaymentRegistry: await orchestrator.paymentVerifierRegistry({ blockTag }),
    upv3: await readBindings(upv3, blockTag), upv3Methods: await upv3.getPaymentMethods({ blockTag }),
    requiredSignatures: await mav.requiredSignatures({ blockTag }), witnesses: await mav.witnesses({ blockTag }),
  };
}

async function deploymentTimestamp(hre: HardhatRuntimeEnvironment, record: Deployment): Promise<number> {
  const blockNumber = record.receipt?.blockNumber;
  assert.ok(blockNumber !== undefined, "UPV4 deployment receipt block is missing");
  const block = await hre.ethers.provider.getBlock(blockNumber);
  assert.ok(block, "UPV4 deployment receipt block is unavailable");
  return block.timestamp * 1000;
}

function renderedArtifacts(address: string, createdAt: number, sourceSha: string) {
  return Object.values(Upv4SafeBatchKind).map((kind) => {
    const fileName = UPV4_SAFE_BATCH_FILES[kind];
    const batch = renderUpv4SafeBatch(kind, baseCutoverConfig(), address, { createdAt, sourceSha });
    const contents = serializeUpv4SafeBatch(batch);
    return { kind, fileName, contents, sidecar: serializeUpv4SafeBatchSidecar(fileName, contents) };
  });
}

function artifactsMatch(root: string, artifacts: ReturnType<typeof renderedArtifacts>): boolean {
  return artifacts.every(({ fileName, contents, sidecar }) => [
    [resolve(root, fileName), contents], [resolve(root, fileName.replace(/\.json$/, ".sha256.json")), sidecar],
  ].every(([file, expected]) => existsSync(file) && readFileSync(file, "utf8") === expected));
}

function installArtifacts(root: string, artifacts: ReturnType<typeof renderedArtifacts>, address: string): void {
  mkdirSync(root, { recursive: true });
  const supersededDir = resolve(root, "superseded");
  for (const { kind, fileName, contents, sidecar } of artifacts) {
    const batchPath = resolve(root, fileName);
    const sidecarPath = batchPath.replace(/\.json$/, ".sha256.json");
    const supersededSuffix = randomUUID();
    // A crash between the pair's two renames can leave one file; retain it before reinstalling.
    if (existsSync(batchPath) !== existsSync(sidecarPath)) {
      mkdirSync(supersededDir, { recursive: true });
      const orphan = existsSync(batchPath) ? batchPath : sidecarPath;
      renameSync(orphan, resolve(supersededDir, basename(orphan).replace(/\.json$/, `_${supersededSuffix}.json`)));
    }
    installSafeArtifactPair({ batchPath, sidecarPath, supersededDir,
      batchContents: contents, sidecarContents: sidecar, supersededSuffix });
    const written: Upv4SafeBatch = JSON.parse(readFileSync(batchPath, "utf8"));
    assertUpv4SafeBatch(kind, written, baseCutoverConfig(), address);
    console.log(`[${TAG}] ${fileName}`);
    console.table(decodeUpv4SafeBatch(written, baseCutoverConfig()));
  }
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

export function createUpv4DeploymentLane(options: LaneOptions = {}): DeployFunction {
  const git = options.git ?? ((args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }));
  const artifactRoot = options.artifactRoot ?? resolve(ROOT, "deployments/outputs/safe-batches");
  const func: DeployFunction = async (hre) => {
    assertTaggedFlags();
    const network = hre.deployments.getNetworkName();
    if (network === "localhost" || network === "hardhat") return deployLocal(hre);
    if (network !== "base") return;
    assert.equal(process.env.DEPLOY_ACTIVE_TAG, TAG, `Lane 47 requires DEPLOY_ACTIVE_TAG=${TAG}`);
    assert.equal(process.env[LIVE_FLAG], "true", `${LIVE_FLAG}=true required`);
    const sourceSha = assertReviewedSource(process.env[RELEASE_SHA_FLAG], git(["rev-parse", "HEAD"]),
      git(["status", "--porcelain", "--untracked-files=all"]));
    const blockTag = await hre.ethers.provider.getBlockNumber();
    assert.equal((await hre.ethers.provider.getNetwork()).chainId, PINS.chainId, "Base chainId mismatch");
    const [deployer] = await hre.getUnnamedAccounts();
    assertAddress(deployer, PINS.deployer, "Base deployer");
    assertBaseSnapshot(await readBaseSnapshot(hre, blockTag));
    const artifact = await hre.deployments.getArtifact(DEPLOYMENT_NAME);
    assertStagingSource(artifact.deployedBytecode,
      await hre.ethers.provider.getCode(PINS.stagingUnifiedPaymentVerifierV4, blockTag));
    const record = await hre.deployments.getOrNull(DEPLOYMENT_NAME);
    const snapshot = record ? await readUpv4(hre, record.address, blockTag) : null;
    if (snapshot) assertUpv4Snapshot(snapshot, baseBindings(), baseCutoverConfig().routes.map((route) => route.method),
      PINS.chainId, deployer, PINS.safe);
    const createdAt = record ? await deploymentTimestamp(hre, record) : undefined;
    const populated = await populateVerifier(hre, record, snapshot, baseCutoverConfig(), baseBindings(), deployer, blockTag);
    installArtifacts(artifactRoot, renderedArtifacts(populated.record.address,
      createdAt ?? await deploymentTimestamp(hre, populated.record), sourceSha), populated.record.address);
  };
  func.skip = async (hre) => {
    assertTaggedFlags();
    const network = hre.deployments.getNetworkName();
    if (network === "localhost" || network === "hardhat") return false;
    if (network === "base_staging") {
      if (process.env.DEPLOY_ACTIVE_TAG === TAG) console.log(`[${TAG}] Base staging already runs UPV4; skipped`);
      return true;
    }
    if (network !== "base" || process.env.DEPLOY_ACTIVE_TAG !== TAG) return true;
    const record = await hre.deployments.getOrNull(DEPLOYMENT_NAME);
    if (!record) return false;
    const snapshot = await readUpv4(hre, record.address, await hre.ethers.provider.getBlockNumber());
    assertUpv4Snapshot(snapshot, baseBindings(), baseCutoverConfig().routes.map((route) => route.method),
      PINS.chainId, PINS.deployer, PINS.safe);
    if (!same(snapshot.owner, PINS.safe)) return false;
    const sourceSha = git(["rev-parse", "HEAD"]).trim();
    if (process.env[RELEASE_SHA_FLAG] !== undefined && process.env[RELEASE_SHA_FLAG] !== sourceSha) return false;
    return artifactsMatch(artifactRoot, renderedArtifacts(record.address, await deploymentTimestamp(hre, record), sourceSha));
  };
  func.tags = [TAG, DEPLOYMENT_NAME];
  return func;
}

export default createUpv4DeploymentLane();
