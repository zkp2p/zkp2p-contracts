import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, providers, utils } from "ethers";
import { UPV4_BASE_RELEASE, UPV5_BASE_RELEASE, UPV5_BASE_STAGING_RELEASE } from "./parameters";

export enum Upv5Network {
  Base = "base",
  BaseStaging = "base_staging",
}

export enum Upv5DeploymentName {
  NullifierRegistryV3 = "NullifierRegistryV3",
  UnifiedPaymentVerifierV5 = "UnifiedPaymentVerifierV5",
  DisputeVerifierV2 = "DisputeVerifierV2",
}

export enum Upv5Target {
  NullifierRegistryV2 = "NullifierRegistryV2",
  NullifierRegistryV3 = "NullifierRegistryV3",
  PaymentVerifierRegistry = "PaymentVerifierRegistry",
  DisputeProtectionPolicyV2 = "DisputeProtectionPolicyV2",
}

export enum Upv5Function {
  AddWriter = "addWritePermission(address)",
  RemoveWriter = "removeWritePermission(address)",
  RemoveMethod = "removePaymentMethod(bytes32)",
  AddMethod = "addPaymentMethod(bytes32,address,bytes32[])",
  SetDisputeVerifier = "setDisputeVerifier(address)",
}

export interface Upv5ReleasePins {
  chainId: number;
  deployer: string;
  governance: string;
  orchestratorRegistry: string;
  multiAttestationVerifier: string;
  paymentVerifierRegistry: string;
  nullifierRegistryV2: string;
  unifiedPaymentVerifierV4: string;
  disputeProtectionPolicyV2: string;
  disputeVerifier: string;
  disputeAttestationVerifier: string;
}

export interface Upv5Deployed {
  nullifierRegistryV3: string;
  unifiedPaymentVerifierV5: string;
  disputeVerifierV2: string;
}

export interface Upv5ContractAddresses extends Upv5Deployed {
  nullifierRegistryV2: string;
  unifiedPaymentVerifierV4: string;
  paymentVerifierRegistry: string;
  disputeProtectionPolicyV2: string;
  disputeVerifier: string;
}

export interface Upv5Route {
  method: string;
  currencies: string[];
  label?: string;
  currencyLabels?: string[];
}

export interface Upv5CutoverInput {
  chainId: number;
  paymentVerifierRegistry: string;
  nullifierRegistryV2: string;
  disputeProtectionPolicyV2: string;
  deployed: Upv5Deployed;
  retiredWriters: string[];
  routes: Upv5Route[];
}

export interface Upv5Call {
  to: string;
  target: Upv5Target;
  signature: Upv5Function;
  args: Array<string | string[]>;
  description: string;
}

export const UPV5_DEPLOYMENT_NAMES: readonly Upv5DeploymentName[] = Object.values(Upv5DeploymentName);

export const UPV5_CALL_INTERFACES: Record<Upv5Target, utils.Interface> = {
  [Upv5Target.NullifierRegistryV2]: new utils.Interface([`function ${Upv5Function.RemoveWriter}`]),
  [Upv5Target.NullifierRegistryV3]: new utils.Interface([`function ${Upv5Function.AddWriter}`]),
  [Upv5Target.PaymentVerifierRegistry]: new utils.Interface([
    `function ${Upv5Function.RemoveMethod}`, `function ${Upv5Function.AddMethod}`,
  ]),
  [Upv5Target.DisputeProtectionPolicyV2]: new utils.Interface([`function ${Upv5Function.SetDisputeVerifier}`]),
};

export const lower = (value: string): string => value.toLowerCase();
export const sameAddress = (left: string, right: string): boolean => lower(left) === lower(right);

export function parseUpv5Network(value: string): Upv5Network {
  const network = Object.values(Upv5Network).find((candidate) => candidate === value);
  if (network === undefined) throw new Error(`Unsupported UPV5 network: ${value}`);
  return network;
}

export function upv5ReleasePins(network: Upv5Network): Upv5ReleasePins {
  const pins = network === Upv5Network.Base ? UPV5_BASE_RELEASE : UPV5_BASE_STAGING_RELEASE;
  return {
    chainId: pins.chainId, deployer: pins.deployer, governance: pins.governance,
    orchestratorRegistry: pins.orchestratorRegistry, multiAttestationVerifier: pins.multiAttestationVerifier,
    paymentVerifierRegistry: pins.paymentVerifierRegistry, nullifierRegistryV2: pins.nullifierRegistryV2,
    unifiedPaymentVerifierV4: pins.unifiedPaymentVerifierV4,
    disputeProtectionPolicyV2: pins.disputeProtectionPolicyV2, disputeVerifier: pins.disputeVerifier,
    disputeAttestationVerifier: pins.disputeAttestationVerifier,
  };
}

export function nonzeroAddress(value: string, field: string): string {
  if (typeof value !== "string" || !utils.isAddress(value) || lower(value) === constants.AddressZero) {
    throw new Error(`${field}: invalid or zero address`);
  }
  return utils.getAddress(value);
}

function hashes(values: string[], field: string): string[] {
  if (values.length === 0) throw new Error(`${field}: empty`);
  const normalized = values.map((value) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value) || value === constants.HashZero) {
      throw new Error(`${field}: invalid or zero hash`);
    }
    return lower(value);
  });
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field}: duplicate hash`);
  return normalized;
}

function recordAddress(root: string, network: string, name: string): string | null {
  const file = resolve(root, "deployments", network, `${name}.json`);
  if (!existsSync(file)) return null;
  const record: { address?: unknown } = JSON.parse(readFileSync(file, "utf8"));
  if (typeof record.address !== "string") throw new Error(`${network}/${name}.json: address missing`);
  return nonzeroAddress(record.address, `${network}/${name}.json`);
}

/** All three records or none: a partial set means an interrupted deployment that must be resumed first. */
export function readUpv5Deployed(root: string, network: string): Upv5Deployed | null {
  const [nullifierRegistryV3, unifiedPaymentVerifierV5, disputeVerifierV2] =
    UPV5_DEPLOYMENT_NAMES.map((name) => recordAddress(root, network, name));
  const present = [nullifierRegistryV3, unifiedPaymentVerifierV5, disputeVerifierV2].filter((value) => value !== null);
  if (present.length === 0) return null;
  if (!nullifierRegistryV3 || !unifiedPaymentVerifierV5 || !disputeVerifierV2) {
    throw new Error(`${network}: partial UPV5 deployment records; resume lane 49 before using them`);
  }
  return { nullifierRegistryV3, unifiedPaymentVerifierV5, disputeVerifierV2 };
}

/** Pinned networks must find their predecessors exactly where the release pins say. */
export function readUpv5Addresses(root: string, network: string): Upv5ContractAddresses {
  const deployed = readUpv5Deployed(root, network);
  if (!deployed) throw new Error(`${network}: UPV5 deployment records missing; run lane 49 first`);
  const required = (name: string): string => {
    const address = recordAddress(root, network, name);
    if (!address) throw new Error(`${network}/${name}.json missing`);
    return address;
  };
  const addresses: Upv5ContractAddresses = {
    ...deployed,
    nullifierRegistryV2: required("NullifierRegistryV2"),
    unifiedPaymentVerifierV4: required("UnifiedPaymentVerifierV4"),
    paymentVerifierRegistry: required("PaymentVerifierRegistry"),
    disputeProtectionPolicyV2: required("DisputeProtectionPolicyV2"),
    disputeVerifier: required("DisputeVerifier"),
  };
  if (Object.values(Upv5Network).some((candidate) => candidate === network)) {
    const pins = upv5ReleasePins(parseUpv5Network(network));
    for (const field of ["nullifierRegistryV2", "unifiedPaymentVerifierV4", "paymentVerifierRegistry",
      "disputeProtectionPolicyV2", "disputeVerifier"] as const) {
      if (!sameAddress(addresses[field], pins[field])) throw new Error(`${network}: ${field} record differs from the release pin`);
    }
  }
  return addresses;
}

export interface Upv5RecordedBindings {
  orchestratorRegistry: string;
  attestationVerifier: string;
  disputeAttestationVerifier: string;
}

function recordArgs(root: string, network: string, name: string, length: number): string[] {
  const record: { args?: unknown } = JSON.parse(readFileSync(resolve(root, "deployments", network, `${name}.json`), "utf8"));
  if (!Array.isArray(record.args) || record.args.length !== length) {
    throw new Error(`${network}/${name}.json: expected ${length} constructor args`);
  }
  return record.args.map((arg: unknown, index: number) => nonzeroAddress(String(arg), `${network}/${name}.json args[${index}]`));
}

/**
 * The constructor bindings lane 49 recorded, which later checks compare against instead of the live UPV4 or
 * DisputeVerifier: those may legitimately change after the cutover. Pinned networks must match their pins.
 */
export function readUpv5Bindings(root: string, network: string, deployed: Upv5Deployed): Upv5RecordedBindings {
  const [orchestratorRegistry, upv5Registry, attestationVerifier] =
    recordArgs(root, network, Upv5DeploymentName.UnifiedPaymentVerifierV5, 3);
  const [owner, disputeRegistry, disputeAttestationVerifier] = recordArgs(root, network, Upv5DeploymentName.DisputeVerifierV2, 3);
  const [predecessor] = recordArgs(root, network, Upv5DeploymentName.NullifierRegistryV3, 1);
  if (!sameAddress(upv5Registry, deployed.nullifierRegistryV3) || !sameAddress(disputeRegistry, deployed.nullifierRegistryV3)) {
    throw new Error(`${network}: UPV5 stack records are not bound to the recorded NullifierRegistryV3`);
  }
  if (Object.values(Upv5Network).some((candidate) => candidate === network)) {
    const pins = upv5ReleasePins(parseUpv5Network(network));
    const expected: Array<[string, string, string]> = [
      ["NullifierRegistryV3 predecessor", predecessor, pins.nullifierRegistryV2],
      ["UPV5 orchestratorRegistry", orchestratorRegistry, pins.orchestratorRegistry],
      ["UPV5 attestationVerifier", attestationVerifier, pins.multiAttestationVerifier],
      ["DisputeVerifierV2 owner", owner, pins.governance],
      ["DisputeVerifierV2 attestationVerifier", disputeAttestationVerifier, pins.disputeAttestationVerifier],
    ];
    for (const [label, actual, pin] of expected) {
      if (!sameAddress(actual, pin)) throw new Error(`${network}: recorded ${label} ${actual} differs from the release pin`);
    }
  }
  return { orchestratorRegistry, attestationVerifier, disputeAttestationVerifier };
}

export interface Upv5CatalogPlan {
  source: string;
  routes: Array<{ method: string; currencies: string[] }>;
}

export interface Upv5StagingJournal {
  network: Upv5Network;
  chainId: number;
  plannedAtBlock: number;
  deployed: Upv5Deployed;
  retiredWriters: string[];
  routes: Upv5Route[];
  transactions: Array<{ index: number; description: string; to: string; data: string; hash: string; blockNumber: number }>;
}

export const UPV5_STAGING_JOURNAL_PATH = "deployments/outputs/upv5-cutover-base_staging.json";

export function readUpv5StagingJournal(root: string): Upv5StagingJournal | null {
  const file = resolve(root, UPV5_STAGING_JOURNAL_PATH);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** Base keeps the 13 pinned UPV4 routes; staging keeps whatever its journal planned. Elsewhere there is no plan. */
export function upv5CatalogFor(root: string, network: string): Upv5CatalogPlan | null {
  if (network === Upv5Network.Base) {
    return {
      source: "UPV4_BASE_RELEASE.paymentRoutes",
      routes: UPV4_BASE_RELEASE.paymentRoutes.map(({ method, currencies }) => ({
        method: utils.id(method), currencies: currencies.map(utils.id),
      })),
    };
  }
  const journal = network === Upv5Network.BaseStaging ? readUpv5StagingJournal(root) : null;
  return journal ? { source: UPV5_STAGING_JOURNAL_PATH, routes: journal.routes } : null;
}

export function validateUpv5CutoverInput(input: Upv5CutoverInput): Upv5CutoverInput {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("chainId: invalid");
  const deployed: Upv5Deployed = {
    nullifierRegistryV3: nonzeroAddress(input.deployed.nullifierRegistryV3, "nullifierRegistryV3"),
    unifiedPaymentVerifierV5: nonzeroAddress(input.deployed.unifiedPaymentVerifierV5, "unifiedPaymentVerifierV5"),
    disputeVerifierV2: nonzeroAddress(input.deployed.disputeVerifierV2, "disputeVerifierV2"),
  };
  const fixed = {
    paymentVerifierRegistry: nonzeroAddress(input.paymentVerifierRegistry, "paymentVerifierRegistry"),
    nullifierRegistryV2: nonzeroAddress(input.nullifierRegistryV2, "nullifierRegistryV2"),
    disputeProtectionPolicyV2: nonzeroAddress(input.disputeProtectionPolicyV2, "disputeProtectionPolicyV2"),
  };
  const all = [...Object.values(fixed), ...Object.values(deployed)];
  if (new Set(all).size !== all.length) throw new Error("addresses: duplicate address");
  const retiredWriters = input.retiredWriters.map((writer, index) => nonzeroAddress(writer, `retiredWriters[${index}]`));
  if (new Set(retiredWriters).size !== retiredWriters.length) throw new Error("retiredWriters: duplicate address");
  if (retiredWriters.some((writer) => all.includes(writer))) {
    throw new Error("retiredWriters: conflicts with a cutover contract");
  }
  const methods = hashes(input.routes.map((route) => route.method), "routes");
  const routes = input.routes.map((route, index) => {
    const currencies = hashes(route.currencies, `routes[${index}].currencies`);
    if (route.label !== undefined && utils.id(route.label) !== methods[index]) {
      throw new Error(`routes[${index}].label: hash mismatch`);
    }
    if (route.currencyLabels !== undefined && (route.currencyLabels.length !== currencies.length ||
      route.currencyLabels.some((label, currencyIndex) => utils.id(label) !== currencies[currencyIndex]))) {
      throw new Error(`routes[${index}].currencyLabels: hash mismatch`);
    }
    return { ...route, method: methods[index], currencies };
  });
  return { ...input, ...fixed, deployed, retiredWriters, routes };
}

/**
 * Orders every UPV5 cutover call: removal of each retired NullifierRegistryV2 writer, UPV5's V3 write grant,
 * every route removed from the tail and re-added in its original order on UPV5 (PaymentVerifierRegistry removes
 * by swap-and-pop, so this keeps the order and the currencies), then the dispute-verifier switch. Base runs these calls in one Safe transaction; staging sends them
 * one by one in this order, so NullifierRegistryV2 stops accepting writes before V3 accepts its first one.
 */
export function buildUpv5CutoverCalls(input: Upv5CutoverInput): Upv5Call[] {
  const checked = validateUpv5CutoverInput(input);
  const { nullifierRegistryV3, unifiedPaymentVerifierV5, disputeVerifierV2 } = checked.deployed;
  const call = (to: string, target: Upv5Target, signature: Upv5Function, args: Array<string | string[]>,
    description: string): Upv5Call => ({ to, target, signature, args, description });
  return [
    ...checked.retiredWriters.map((writer) => call(checked.nullifierRegistryV2, Upv5Target.NullifierRegistryV2,
      Upv5Function.RemoveWriter, [writer], `NullifierRegistryV2 removeWritePermission ${writer}`)),
    call(nullifierRegistryV3, Upv5Target.NullifierRegistryV3, Upv5Function.AddWriter, [unifiedPaymentVerifierV5],
      `NullifierRegistryV3 addWritePermission UPV5 ${unifiedPaymentVerifierV5}`),
    ...[...checked.routes].reverse().map((route) => call(checked.paymentVerifierRegistry,
      Upv5Target.PaymentVerifierRegistry, Upv5Function.RemoveMethod, [route.method],
      `PaymentVerifierRegistry remove ${route.label ?? route.method}`)),
    ...checked.routes.map((route) => call(checked.paymentVerifierRegistry, Upv5Target.PaymentVerifierRegistry,
      Upv5Function.AddMethod, [route.method, unifiedPaymentVerifierV5, [...route.currencies]],
      `PaymentVerifierRegistry route ${route.label ?? route.method} to UPV5`)),
    call(checked.disputeProtectionPolicyV2, Upv5Target.DisputeProtectionPolicyV2, Upv5Function.SetDisputeVerifier,
      [disputeVerifierV2], `DisputeProtectionPolicyV2 setDisputeVerifier ${disputeVerifierV2}`),
  ];
}

export function scalarArg(call: Upv5Call, index: number): string {
  const value = call.args[index];
  if (typeof value !== "string") throw new Error(`${call.description}: argument ${index} is not a single value`);
  return value;
}

export function listArg(call: Upv5Call, index: number): string[] {
  const value = call.args[index];
  if (!Array.isArray(value)) throw new Error(`${call.description}: argument ${index} is not a list`);
  return value;
}

/**
 * Simulates one call with a raw eth_call, which rejects on any revert. ethers' `provider.call` returns custom-error
 * revert data as if it were a result, so it cannot tell these state-changing calls' success from failure.
 */
export async function simulateUpv5Call(
  provider: providers.JsonRpcProvider, from: string, call: { to: string; data: string }, blockTag: number,
): Promise<void> {
  await provider.send("eth_call", [{ from, to: call.to, data: call.data }, utils.hexValue(blockTag)]);
}

export function encodeUpv5Call(call: Upv5Call): { to: string; value: "0"; data: string } {
  return { to: call.to, value: "0", data: UPV5_CALL_INTERFACES[call.target].encodeFunctionData(call.signature, call.args) };
}

export interface Upv5RoutingState {
  unifiedPaymentVerifierV5: string;
  nullifierRegistryV2Writers: string[];
  nullifierRegistryV3Writers: string[];
  routes: Array<{ method: string; verifier: string; currencies: string[] }>;
  policyDisputeVerifier: string;
}

/** Whether the live state already reflects a call; staging resumes from the first call that does not. */
export function upv5CallApplied(call: Upv5Call, state: Upv5RoutingState): boolean {
  const route = call.signature === Upv5Function.RemoveMethod || call.signature === Upv5Function.AddMethod
    ? state.routes.find((candidate) => lower(candidate.method) === lower(scalarArg(call, 0))) : undefined;
  switch (call.signature) {
    case Upv5Function.RemoveWriter:
      return !state.nullifierRegistryV2Writers.some((writer) => sameAddress(writer, scalarArg(call, 0)));
    case Upv5Function.AddWriter:
      return state.nullifierRegistryV3Writers.some((writer) => sameAddress(writer, scalarArg(call, 0)));
    case Upv5Function.RemoveMethod:
      return route === undefined || sameAddress(route.verifier, state.unifiedPaymentVerifierV5);
    case Upv5Function.AddMethod:
      return route !== undefined && sameAddress(route.verifier, scalarArg(call, 1));
    case Upv5Function.SetDisputeVerifier:
      return sameAddress(state.policyDisputeVerifier, scalarArg(call, 0));
  }
}

/**
 * Splits a cutover plan into the calls the chain already reflects and those still to send. Applied calls must
 * form a prefix of the plan; anything else means the state moved outside this script and it stops.
 */
export function pendingUpv5Calls(calls: Upv5Call[], state: Upv5RoutingState): Upv5Call[] {
  const applied = calls.map((call) => upv5CallApplied(call, state));
  const firstPending = applied.indexOf(false);
  if (firstPending === -1) return [];
  const stray = applied.findIndex((done, index) => done && index > firstPending);
  if (stray !== -1) {
    throw new Error(`Cutover state is not a prefix of the plan: call ${stray} (${calls[stray].description}) ` +
      `is applied but call ${firstPending} (${calls[firstPending].description}) is not`);
  }
  return calls.slice(firstPending);
}
