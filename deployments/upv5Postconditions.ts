import { Contract, constants, providers, utils } from "ethers";
import {
  Upv5CatalogPlan, Upv5ContractAddresses, Upv5Deployed, Upv5RecordedBindings, Upv5RoutingState, lower, sameAddress,
} from "./upv5Cutover";

const READ_ABI = {
  nullifierRegistry: [
    "function getWriters() view returns (address[])", "function owner() view returns (address)",
    "function predecessor() view returns (address)", "function legacyNullifierRegistry() view returns (address)",
  ],
  verifier: [
    "function nullifierRegistry() view returns (address)", "function attestationVerifier() view returns (address)",
    "function orchestratorRegistry() view returns (address)", "function owner() view returns (address)",
    "function getPaymentMethods() view returns (bytes32[])",
  ],
  paymentVerifierRegistry: [
    "function getPaymentMethods() view returns (bytes32[])", "function getVerifier(bytes32) view returns (address)",
    "function getCurrencies(bytes32) view returns (bytes32[])", "function owner() view returns (address)",
  ],
  policy: ["function disputeVerifier() view returns (address)", "function owner() view returns (address)"],
  disputeVerifier: [
    "function nullifierRegistry() view returns (address)", "function attestationVerifier() view returns (address)",
    "function owner() view returns (address)", "function pendingOwner() view returns (address)",
  ],
};

export interface Upv5Snapshot {
  blockNumber: number;
  nullifierRegistryV2Writers: string[];
  legacyNullifierRegistryWriters: string[];
  nullifierRegistryV3: { writers: string[]; predecessor: string; owner: string };
  unifiedPaymentVerifierV5: {
    nullifierRegistry: string; attestationVerifier: string; orchestratorRegistry: string; owner: string; methods: string[];
  };
  unifiedPaymentVerifierV4: { methods: string[] };
  routes: Array<{ method: string; verifier: string; currencies: string[] }>;
  policy: { disputeVerifier: string; owner: string };
  paymentVerifierRegistryOwner: string;
  nullifierRegistryV2Owner: string;
  disputeVerifierV2: { nullifierRegistry: string; attestationVerifier: string; owner: string; pendingOwner: string };
}

/** Deployment checks hold from lane 49 onwards; cutover checks become true only when the cutover executes. */
export enum Upv5CheckPhase {
  Deployment = "deployment",
  Cutover = "cutover",
}

export interface Upv5Check {
  name: string;
  phase: Upv5CheckPhase;
  ok: boolean;
  detail: string;
}

export interface Upv5Expectations {
  governance: string;
  bindings: Upv5RecordedBindings;
  /** The routes the cutover must leave in place; null while staging has no journal yet. */
  catalog: Upv5CatalogPlan | null;
}

/** Every read is pinned to one block so the checks describe a single consistent state. */
export async function readUpv5Snapshot(
  provider: providers.Provider, addresses: Upv5ContractAddresses, blockTag?: number,
): Promise<Upv5Snapshot> {
  const blockNumber = blockTag ?? await provider.getBlockNumber();
  const options = { blockTag: blockNumber };
  const at = (address: string, abi: string[]) => new Contract(address, abi, provider);
  const nrv2 = at(addresses.nullifierRegistryV2, READ_ABI.nullifierRegistry);
  const nrv3 = at(addresses.nullifierRegistryV3, READ_ABI.nullifierRegistry);
  const upv5 = at(addresses.unifiedPaymentVerifierV5, READ_ABI.verifier);
  const upv4 = at(addresses.unifiedPaymentVerifierV4, READ_ABI.verifier);
  const pvr = at(addresses.paymentVerifierRegistry, READ_ABI.paymentVerifierRegistry);
  const policy = at(addresses.disputeProtectionPolicyV2, READ_ABI.policy);
  const dv2 = at(addresses.disputeVerifierV2, READ_ABI.disputeVerifier);
  const legacy = at(await nrv2.legacyNullifierRegistry(options), READ_ABI.nullifierRegistry);
  const methods: string[] = await pvr.getPaymentMethods(options);
  return {
    blockNumber,
    nullifierRegistryV2Writers: await nrv2.getWriters(options),
    legacyNullifierRegistryWriters: await legacy.getWriters(options),
    nullifierRegistryV2Owner: await nrv2.owner(options),
    nullifierRegistryV3: {
      writers: await nrv3.getWriters(options), predecessor: await nrv3.predecessor(options), owner: await nrv3.owner(options),
    },
    unifiedPaymentVerifierV5: {
      nullifierRegistry: await upv5.nullifierRegistry(options), attestationVerifier: await upv5.attestationVerifier(options),
      orchestratorRegistry: await upv5.orchestratorRegistry(options), owner: await upv5.owner(options),
      methods: await upv5.getPaymentMethods(options),
    },
    unifiedPaymentVerifierV4: { methods: await upv4.getPaymentMethods(options) },
    routes: await Promise.all(methods.map(async (method) => ({
      method, verifier: await pvr.getVerifier(method, options), currencies: await pvr.getCurrencies(method, options),
    }))),
    paymentVerifierRegistryOwner: await pvr.owner(options),
    policy: { disputeVerifier: await policy.disputeVerifier(options), owner: await policy.owner(options) },
    disputeVerifierV2: {
      nullifierRegistry: await dv2.nullifierRegistry(options), attestationVerifier: await dv2.attestationVerifier(options),
      owner: await dv2.owner(options), pendingOwner: await dv2.pendingOwner(options),
    },
  };
}

export function routingStateFromSnapshot(snapshot: Upv5Snapshot, addresses: Upv5Deployed): Upv5RoutingState {
  return {
    unifiedPaymentVerifierV5: addresses.unifiedPaymentVerifierV5,
    nullifierRegistryV2Writers: snapshot.nullifierRegistryV2Writers,
    nullifierRegistryV3Writers: snapshot.nullifierRegistryV3.writers,
    routes: snapshot.routes, policyDisputeVerifier: snapshot.policy.disputeVerifier,
  };
}

/** First difference between the live catalog and the plan: method order, then each method's currencies. */
export function catalogDrift(routes: Upv5Snapshot["routes"], plan: Upv5CatalogPlan): string | null {
  const live = routes.map((route) => lower(route.method));
  const planned = plan.routes.map((route) => lower(route.method));
  if (JSON.stringify(live) !== JSON.stringify(planned)) {
    return `methods [${live.join(", ")}] differ from ${plan.source} [${planned.join(", ")}]`;
  }
  const changed = plan.routes.find((route, index) =>
    JSON.stringify(routes[index].currencies.map(lower)) !== JSON.stringify(route.currencies.map(lower)));
  return changed ? `currencies of ${changed.method} differ from ${plan.source}` : null;
}

/**
 * The cutover's end state. Before the cutover the failing checks are the work still to do. Bindings come from the
 * deployment records, never from the live UPV4 or DisputeVerifier, which may legitimately change afterwards. The
 * two "Cutover-time" checks compare mutable attestation verifiers with those records: they hold at the cutover, not
 * forever, since governance may later rotate a verifier with `setAttestationVerifier`.
 */
export function evaluateUpv5Postconditions(
  snapshot: Upv5Snapshot, addresses: Upv5ContractAddresses, expected: Upv5Expectations,
): Upv5Check[] {
  const { governance, bindings, catalog } = expected;
  const { nullifierRegistryV3: v3, unifiedPaymentVerifierV5: upv5, disputeVerifierV2: dv2 } = snapshot;
  const check = (name: string, ok: boolean, detail: string): Upv5Check => ({ name, phase: Upv5CheckPhase.Deployment, ok, detail });
  const cutover = (name: string, ok: boolean, detail: string): Upv5Check => ({ name, phase: Upv5CheckPhase.Cutover, ok, detail });
  const is = (actual: string, wanted: string, label: string) => sameAddress(actual, wanted)
    ? `${label} ${utils.getAddress(actual)}` : `${label} is ${actual}, expected ${utils.getAddress(wanted)}`;
  const unsupported = snapshot.routes.filter((route) => !upv5.methods.some((method) => lower(method) === lower(route.method)));
  const unrouted = snapshot.routes.filter((route) => !sameAddress(route.verifier, addresses.unifiedPaymentVerifierV5));
  const drift = catalog ? catalogDrift(snapshot.routes, catalog) : "no plan recorded yet (the staging journal is written by --execute)";
  return [
    cutover("NullifierRegistryV2 has no writers", snapshot.nullifierRegistryV2Writers.length === 0,
      `writers [${snapshot.nullifierRegistryV2Writers.join(", ")}]`),
    check("Legacy NullifierRegistry has no writers", snapshot.legacyNullifierRegistryWriters.length === 0,
      `writers [${snapshot.legacyNullifierRegistryWriters.join(", ")}]`),
    cutover("NullifierRegistryV3's only writer is UPV5",
      v3.writers.length === 1 && sameAddress(v3.writers[0], addresses.unifiedPaymentVerifierV5), `writers [${v3.writers.join(", ")}]`),
    check("NullifierRegistryV3.predecessor() is NullifierRegistryV2", sameAddress(v3.predecessor, addresses.nullifierRegistryV2),
      is(v3.predecessor, addresses.nullifierRegistryV2, "predecessor")),
    check("UPV5.nullifierRegistry() is NullifierRegistryV3", sameAddress(upv5.nullifierRegistry, addresses.nullifierRegistryV3),
      is(upv5.nullifierRegistry, addresses.nullifierRegistryV3, "nullifierRegistry")),
    check("Cutover-time: UPV5 attestation verifier is the one recorded at deployment", sameAddress(upv5.attestationVerifier, bindings.attestationVerifier),
      is(upv5.attestationVerifier, bindings.attestationVerifier, "attestationVerifier")),
    check("UPV5 orchestrator registry is the one recorded at deployment",
      sameAddress(upv5.orchestratorRegistry, bindings.orchestratorRegistry),
      is(upv5.orchestratorRegistry, bindings.orchestratorRegistry, "orchestratorRegistry")),
    check("Every routed payment method is supported by UPV5", snapshot.routes.length > 0 && unsupported.length === 0,
      unsupported.length === 0 ? `${snapshot.routes.length} methods` : `unsupported [${unsupported.map((route) => route.method).join(", ")}]`),
    cutover("Every PaymentVerifierRegistry method routes to UPV5", snapshot.routes.length > 0 && unrouted.length === 0,
      unrouted.length === 0 ? `${snapshot.routes.length} routes`
        : `${unrouted.length} of ${snapshot.routes.length} routes elsewhere: ${unrouted.map((route) => `${route.method} -> ${route.verifier}`).join(", ")}`),
    cutover("PaymentVerifierRegistry catalog equals the plan", drift === null,
      drift ?? `${snapshot.routes.length} methods, order and currencies equal ${catalog?.source}`),
    cutover("DisputeProtectionPolicyV2.disputeVerifier() is DisputeVerifierV2",
      sameAddress(snapshot.policy.disputeVerifier, addresses.disputeVerifierV2),
      is(snapshot.policy.disputeVerifier, addresses.disputeVerifierV2, "disputeVerifier")),
    check("DisputeVerifierV2.nullifierRegistry() is NullifierRegistryV3", sameAddress(dv2.nullifierRegistry, addresses.nullifierRegistryV3),
      is(dv2.nullifierRegistry, addresses.nullifierRegistryV3, "nullifierRegistry")),
    check("Cutover-time: DisputeVerifierV2 attestation verifier is the one recorded at deployment",
      sameAddress(dv2.attestationVerifier, bindings.disputeAttestationVerifier),
      is(dv2.attestationVerifier, bindings.disputeAttestationVerifier, "attestationVerifier")),
    check("NullifierRegistryV3 is owned by governance", sameAddress(v3.owner, governance), is(v3.owner, governance, "owner")),
    check("UPV5 is owned by governance", sameAddress(upv5.owner, governance), is(upv5.owner, governance, "owner")),
    check("DisputeVerifierV2 is owned by governance with no pending owner",
      sameAddress(dv2.owner, governance) && sameAddress(dv2.pendingOwner, constants.AddressZero),
      `${is(dv2.owner, governance, "owner")}; pendingOwner ${dv2.pendingOwner}`),
  ];
}

export enum Upv5CheckMode {
  Pre = "pre",
  Post = "post",
}

/** Pre mode lists what the cutover still has to make true; post mode treats every such line as a failure. */
export function formatUpv5Checks(checks: Upv5Check[], mode: Upv5CheckMode): string {
  const pendingLabel = mode === Upv5CheckMode.Pre ? "TODO" : "FAIL";
  return checks.map((check) => `${check.ok ? "PASS" : pendingLabel}  ${check.name}: ${check.detail}`).join("\n") + "\n";
}
