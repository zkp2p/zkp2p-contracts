import type { Contract } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import {
  addPaymentMethodToRegistry,
  addPaymentMethodToUnifiedVerifier,
  savePaymentMethodSnapshot,
} from "./helpers";

export enum ActivePaymentVerifierName {
  V5 = "UnifiedPaymentVerifierV5",
  V4 = "UnifiedPaymentVerifierV4",
}

export enum PaymentMethodActivationMode {
  Prepare = "prepare",
  Execute = "execute",
}

export interface ActivePaymentVerifier {
  name: ActivePaymentVerifierName;
  address: string;
  nullifierRegistryName: string;
}

export interface StagingPaymentMethod {
  label: string;
  key: string;
  paymentMethodHash: string;
  currencies: string[];
}

export interface StagingPaymentMethodLane {
  tag: string;
  tags: string[];
  prepareFlag: string;
  executeFlag: string;
  method: StagingPaymentMethod;
}

const EXPECTED_CHAIN_ID = 8453;
const NULLIFIER_REGISTRY_NAMES: Record<ActivePaymentVerifierName, string> = {
  [ActivePaymentVerifierName.V5]: "NullifierRegistryV3",
  [ActivePaymentVerifierName.V4]: "NullifierRegistryV2",
};

const lower = (value: string): string => value.toLowerCase();
const sameValues = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => lower(value) === lower(right[index]));

/**
 * The verifier a new payment method must join: the one every PaymentVerifierRegistry route already uses. It
 * must be the recorded UnifiedPaymentVerifierV5 or, until the UPV5 cutover routes to it, the recorded
 * UnifiedPaymentVerifierV4. A method on any other verifier would sit outside every other method's replay domain.
 */
export async function resolveActivePaymentVerifier(hre: HardhatRuntimeEnvironment): Promise<ActivePaymentVerifier> {
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry", (await hre.deployments.get("PaymentVerifierRegistry")).address
  );
  const methods: string[] = await registry.getPaymentMethods();
  if (methods.length === 0) throw new Error("PaymentVerifierRegistry has no routes to follow");
  const routed = new Set((await Promise.all(methods.map((method) => registry.getVerifier(method)))).map(lower));
  if (routed.size !== 1) {
    throw new Error(`PaymentVerifierRegistry routes to several verifiers: ${[...routed].join(", ")}`);
  }
  const [verifier] = [...routed];
  for (const name of [ActivePaymentVerifierName.V5, ActivePaymentVerifierName.V4]) {
    const record = await hre.deployments.getOrNull(name);
    if (record && lower(record.address) === verifier) {
      return { name, address: record.address, nullifierRegistryName: NULLIFIER_REGISTRY_NAMES[name] };
    }
  }
  throw new Error(`PaymentVerifierRegistry routes to ${verifier}, which is neither the recorded UPV5 nor UPV4`);
}

/**
 * Adds one payment method on Base staging to the active verifier, then routes it there in
 * PaymentVerifierRegistry. Prepare mode stops after simulating the missing writes. A resumed run skips writes
 * already made; a registry route anywhere but the active verifier, or with other currencies, stops it.
 */
export async function activateStagingPaymentMethod(
  hre: HardhatRuntimeEnvironment, method: StagingPaymentMethod, mode: PaymentMethodActivationMode,
): Promise<void> {
  const { label, paymentMethodHash, currencies } = method;
  if (hre.deployments.getNetworkName() !== "base_staging") {
    throw new Error(`${label} payment-method activation is Base-staging only`);
  }
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Provider chain ID ${chainId} does not match Base ${EXPECTED_CHAIN_ID}`);
  }

  const active = await resolveActivePaymentVerifier(hre);
  const verifier = await hre.ethers.getContractAt(active.name, active.address);
  const registry = await hre.ethers.getContractAt(
    "PaymentVerifierRegistry", (await hre.deployments.get("PaymentVerifierRegistry")).address
  );
  const nullifierRegistryAddress: string = await verifier.nullifierRegistry();
  const nullifierRegistry = await hre.ethers.getContractAt(active.nullifierRegistryName, nullifierRegistryAddress);
  const [deployer] = await hre.getUnnamedAccounts();
  const registryOwner: string = await registry.owner();
  const verifierOwner: string = await verifier.owner();
  const writers: string[] = await nullifierRegistry.getWriters();
  if (!deployer || lower(registryOwner) !== lower(deployer) || lower(verifierOwner) !== lower(deployer)) {
    throw new Error(`${label} activation signer or contract owner mismatch`);
  }
  if (!writers.some((writer) => lower(writer) === lower(active.address))) {
    throw new Error(`${label} activation nullifier writer invariant failed: ${active.name} cannot write ${nullifierRegistryAddress}`);
  }

  const verifierHas: boolean = await verifier.isPaymentMethod(paymentMethodHash);
  const registryHas: boolean = await registry.isPaymentMethod(paymentMethodHash);
  if (registryHas && !verifierHas) throw new Error(`PaymentVerifierRegistry contains ${label} before ${active.name}`);
  if (registryHas) await assertRoute(registry, method, active.address);

  if (!verifierHas) await verifier.callStatic.addPaymentMethod(paymentMethodHash);
  if (!registryHas) await registry.callStatic.addPaymentMethod(paymentMethodHash, active.address, currencies);
  console.log(`${label} Base-staging plan verified on ${active.name} ${active.address}:`, paymentMethodHash, currencies);
  if (mode === PaymentMethodActivationMode.Prepare) return;

  await addPaymentMethodToUnifiedVerifier(hre, verifier, paymentMethodHash);
  await addPaymentMethodToRegistry(hre, registry, paymentMethodHash, active.address, currencies);

  if (!(await verifier.isPaymentMethod(paymentMethodHash))) {
    throw new Error(`${label} Base-staging activation verification failed: ${active.name} lacks the method`);
  }
  await assertRoute(registry, method, active.address);
  savePaymentMethodSnapshot("base_staging", method.key, { paymentMethodHash, currencies });
  console.log(`${label} is active on Base staging through ${active.name}`);
}

async function assertRoute(
  registry: Contract, method: StagingPaymentMethod, verifier: string,
): Promise<void> {
  const [routed, currencies]: [string, string[]] = await Promise.all([
    registry.getVerifier(method.paymentMethodHash), registry.getCurrencies(method.paymentMethodHash),
  ]);
  if (lower(routed) !== lower(verifier) || !sameValues(currencies, method.currencies)) {
    throw new Error(`${method.label} Base-staging activation verification failed: registry routes it to ${routed} ` +
      `with [${currencies.join(", ")}]`);
  }
}

/** Tagged Base-staging lane that runs exactly one of prepare or execute. Untagged runs are inert. */
export function createStagingPaymentMethodLane(lane: StagingPaymentMethodLane): DeployFunction {
  const skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
    if (process.env.DEPLOY_ACTIVE_TAG !== lane.tag) return true;
    if (hre.deployments.getNetworkName() !== "base_staging") return true;
    const prepare = process.env[lane.prepareFlag] === "true";
    const execute = process.env[lane.executeFlag] === "true";
    if (prepare === execute) {
      throw new Error(`Set exactly one of ${lane.prepareFlag} or ${lane.executeFlag}=true`);
    }
    return false;
  };
  const func: DeployFunction = async (hre) => {
    if (await skip(hre)) return;
    const mode = process.env[lane.prepareFlag] === "true"
      ? PaymentMethodActivationMode.Prepare : PaymentMethodActivationMode.Execute;
    await activateStagingPaymentMethod(hre, lane.method, mode);
  };
  func.skip = skip;
  func.tags = [lane.tag, ...lane.tags];
  return func;
}
