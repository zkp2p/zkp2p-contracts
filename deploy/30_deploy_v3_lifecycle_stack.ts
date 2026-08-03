import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_SIG,
  ORCHESTRATOR_V3_PROTOCOL_FEE,
  ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT,
} from "../deployments/parameters";
import {
  addOrchestratorToRegistry,
  removeOrchestratorFromRegistry,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

const LIVE_NETWORKS = new Set(["base", "base_staging"]);
const LOCAL_NETWORKS = new Set(["localhost", "hardhat"]);
const PRESERVED_DEPLOYMENTS = [
  "AddressGroupRegistry",
  "ChargebackNullifierRegistry",
  "ChargebackPolicy",
  "ChargebackVerifier",
  "EscrowRegistry",
  "MultiAttestationVerifier",
  "NullifierRegistryV2",
  "PaymentVerifierRegistry",
  "RelayerRegistry",
  "StakeVault",
  "UnifiedPaymentVerifierV3",
] as const;

const RETIRED_WHITELIST_POLICIES: Record<string, string[]> = {
  base: ["0xE96eD3dBc5869b98a555b137C2dcCDf157eD17B3"],
  base_staging: ["0xe3d3E798AbF1c021730d951d0589bCa63d9CB3F0"],
};
const RETIRED_ORCHESTRATORS: Record<string, string[]> = {
  base: ["0x930B0FD444F51ca2860Ca8F368c3388d3f684030"],
  base_staging: [
    "0x6Db9dDb38a19Be0c614C0Ad9e78Baf73f93c35dF",
    "0xF9CEE6365fB4F6354a19e95d35aaeF877CF1179d",
    "0x1734f5C9956D0DA1F48E27cd1C6167aA81F27869",
  ],
};

type PreservedState = {
  addresses: Record<string, string>;
  paymentRoutes: string;
};

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function configuredAddresses(
  network: string,
  defaults: Record<string, string[]>,
  environmentName: string,
): string[] {
  const values = [...(defaults[network] || []), ...(process.env[environmentName] || "").split(",")];
  const addresses = values.filter(Boolean).map((value) => {
    try {
      return ethers.utils.getAddress(value.trim());
    } catch {
      throw new Error(`${environmentName} contains an invalid address`);
    }
  });
  return [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
}

async function paymentRoutes(registryAddress: string): Promise<string> {
  const registry = await ethers.getContractAt("PaymentVerifierRegistry", registryAddress);
  const methods: string[] = await registry.getPaymentMethods();
  const routes = [];
  for (const method of [...methods].sort()) {
    routes.push({
      method,
      verifier: await registry.getVerifier(method),
      currencies: [...await registry.getCurrencies(method)].sort(),
    });
  }
  return JSON.stringify(routes);
}

async function capturePreservedState(hre: HardhatRuntimeEnvironment): Promise<PreservedState> {
  const addresses: Record<string, string> = {};
  for (const name of PRESERVED_DEPLOYMENTS) {
    const deployment = await hre.deployments.get(name);
    if ((await ethers.provider.getCode(deployment.address)) === "0x") {
      throw new Error(`Preserved ${name} has no bytecode`);
    }
    addresses[name] = deployment.address;
  }
  return {
    addresses,
    paymentRoutes: await paymentRoutes(addresses.PaymentVerifierRegistry),
  };
}

async function assertPreservedState(
  hre: HardhatRuntimeEnvironment,
  expected: PreservedState,
): Promise<void> {
  for (const [name, address] of Object.entries(expected.addresses)) {
    const deployment = await hre.deployments.get(name);
    if (!sameAddress(deployment.address, address)) throw new Error(`${name} address changed`);
    if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${name} lost bytecode`);
  }
  if (await paymentRoutes(expected.addresses.PaymentVerifierRegistry) !== expected.paymentRoutes) {
    throw new Error("Payment method routing changed during the groups cutover");
  }
}

async function proveRetiredOrchestratorsDrained(
  hre: HardhatRuntimeEnvironment,
  retiredAddresses: string[],
  expectedCounters?: Map<string, string>,
): Promise<Map<string, string>> {
  const endpoint = process.env.V3_GROUPS_CUTOVER_INDEXER_GRAPHQL_URL;
  if (LIVE_NETWORKS.has(hre.deployments.getNetworkName()) && retiredAddresses.length && !endpoint) {
    throw new Error("V3_GROUPS_CUTOVER_INDEXER_GRAPHQL_URL is required for the retired O3 drain gate");
  }

  const counters = new Map<string, string>();
  for (const address of retiredAddresses) {
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`Registered retired OrchestratorV3 has no bytecode: ${address}`);
    }
    const retired = new ethers.Contract(
      address,
      ["function intentCounter() view returns (uint256)"],
      ethers.provider,
    );
    const counter = (await retired.intentCounter()).toString();
    const key = address.toLowerCase();
    counters.set(key, counter);
    if (expectedCounters?.has(key) && expectedCounters.get(key) !== counter) {
      throw new Error(`Retired OrchestratorV3 ${address} signaled during the cutover`);
    }
    if (!endpoint) {
      if (counter !== "0") throw new Error(`Local retired OrchestratorV3 ${address} is not empty`);
      continue;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.V3_GROUPS_CUTOVER_INDEXER_API_KEY
            ? { "x-api-key": process.env.V3_GROUPS_CUTOVER_INDEXER_API_KEY }
            : {}),
        },
        body: JSON.stringify({
          query: `query RetiredOrchestratorDrain($orchestrator: String!) {
            indexed: Intent(where: { orchestratorAddress: { _eq: $orchestrator } }, limit: 1) { id }
            pending: Intent(
              where: { orchestratorAddress: { _eq: $orchestrator }, status: { _eq: SIGNALED } }
              limit: 1
            ) { id }
          }`,
          variables: { orchestrator: address.toLowerCase() },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`Indexer drain query failed with HTTP ${response.status}`);
    const payload = await response.json() as {
      data?: { indexed?: unknown[]; pending?: unknown[] };
      errors?: unknown[];
    };
    const indexed = payload.data?.indexed;
    const pending = payload.data?.pending;
    if (payload.errors?.length || !Array.isArray(indexed) || !Array.isArray(pending)) {
      throw new Error("Indexer returned invalid retired O3 drain data");
    }
    if (pending.length) throw new Error(`Retired OrchestratorV3 ${address} has a SIGNALED intent`);
    if (!indexed.length && counter !== "0") {
      throw new Error(`Retired OrchestratorV3 ${address} has unproven indexed history`);
    }
  }
  return counters;
}

async function assertCreationReceipts(
  deployments: Array<[string, { address: string; transactionHash?: string }]>,
): Promise<void> {
  const hashes = new Set<string>();
  for (const [name, deployment] of deployments) {
    if (!deployment.transactionHash) throw new Error(`${name} has no creation transaction`);
    hashes.add(deployment.transactionHash.toLowerCase());
    const receipt = await ethers.provider.getTransactionReceipt(deployment.transactionHash);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress) {
      throw new Error(`${name} creation transaction is missing or unsuccessful`);
    }
    if (!sameAddress(receipt.contractAddress, deployment.address)) {
      throw new Error(`${name} creation receipt does not match its artifact`);
    }
  }
  if (hashes.size !== deployments.length) throw new Error("Cutover creation transactions are not distinct");
}

async function ownerReady(contract: any, governance: string, allowSafe: boolean): Promise<boolean> {
  if (sameAddress(await contract.owner(), governance)) return true;
  if (!allowSafe) return false;
  try {
    return sameAddress(await contract.pendingOwner(), governance)
      && safeBatchCollector.hasQueued(
        contract.address,
        contract.interface.encodeFunctionData("acceptOwnership"),
      );
  } catch {
    return false;
  }
}

async function registryReady(
  registry: any,
  orchestrator: string,
  expected: boolean,
  allowSafe: boolean,
): Promise<boolean> {
  if (await registry.isOrchestrator(orchestrator) === expected) return true;
  if (!allowSafe) return false;
  const method = expected ? "addOrchestrator" : "removeOrchestrator";
  return safeBatchCollector.hasQueued(
    registry.address,
    registry.interface.encodeFunctionData(method, [orchestrator]),
  );
}

function assertAddress(label: string, actual: string, expected: string): void {
  if (!sameAddress(actual, expected)) throw new Error(`${label} mismatch`);
}

async function verifyCutover(
  hre: HardhatRuntimeEnvironment,
  preserved: PreservedState,
  retiredOrchestrators: string[],
  allowSafe: boolean,
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const policyDeployment = await hre.deployments.get("WhitelistPolicy");
  const hookDeployment = await hre.deployments.get("WhitelistLifecycleHook");
  const orchestratorDeployment = await hre.deployments.get("OrchestratorV3");
  const registryDeployment = await hre.deployments.get("OrchestratorRegistry");
  const policy = await ethers.getContractAt("WhitelistPolicy", policyDeployment.address);
  const hook = await ethers.getContractAt("WhitelistLifecycleHook", hookDeployment.address);
  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
  const registry = await ethers.getContractAt("OrchestratorRegistry", registryDeployment.address);

  assertAddress("O3 lifecycle hook", await orchestrator.lifecycleHook(), hookDeployment.address);
  assertAddress("O3 escrow registry", await orchestrator.escrowRegistry(), preserved.addresses.EscrowRegistry);
  assertAddress(
    "O3 payment registry",
    await orchestrator.paymentVerifierRegistry(),
    preserved.addresses.PaymentVerifierRegistry,
  );
  assertAddress("O3 relayer registry", await orchestrator.relayerRegistry(), preserved.addresses.RelayerRegistry);
  assertAddress("Hook orchestrator registry", await hook.orchestratorRegistry(), registry.address);
  assertAddress("Hook whitelist policy", await hook.whitelistPolicy(), policy.address);
  assertAddress("Policy group registry", await policy.groupRegistry(), preserved.addresses.AddressGroupRegistry);
  assertAddress("Policy escrow registry", await policy.escrowRegistry(), preserved.addresses.EscrowRegistry);
  assertAddress("Policy orchestrator registry", await policy.orchestratorRegistry(), registry.address);
  if (!(await orchestrator.chainId()).eq((await ethers.provider.getNetwork()).chainId)) {
    throw new Error("O3 chain id mismatch");
  }
  if (!(await orchestrator.protocolFee()).eq(ORCHESTRATOR_V3_PROTOCOL_FEE[network])) {
    throw new Error("O3 protocol fee mismatch");
  }
  assertAddress(
    "O3 protocol fee recipient",
    await orchestrator.protocolFeeRecipient(),
    ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network] || deployer,
  );
  if (!await ownerReady(orchestrator, governance, allowSafe)) throw new Error("O3 ownership is not ready");
  if (!await ownerReady(policy, governance, allowSafe)) throw new Error("Policy ownership is not ready");
  if (!await registryReady(registry, orchestrator.address, true, allowSafe)) {
    throw new Error("New O3 registration is not ready");
  }
  for (const retired of retiredOrchestrators) {
    if (!sameAddress(retired, orchestrator.address)
      && !await registryReady(registry, retired, false, allowSafe)) {
      throw new Error(`Retired O3 remains authorized: ${retired}`);
    }
  }

  await assertCreationReceipts([
    ["WhitelistPolicy", policyDeployment],
    ["WhitelistLifecycleHook", hookDeployment],
    ["OrchestratorV3", orchestratorDeployment],
  ]);
  await assertPreservedState(hre, preserved);
}

async function fullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    const network = hre.deployments.getNetworkName();
    await verifyCutover(
      hre,
      await capturePreservedState(hre),
      configuredAddresses(network, RETIRED_ORCHESTRATORS, "V3_GROUPS_CUTOVER_RETIRED_ORCHESTRATORS"),
      false,
    );
    return true;
  } catch {
    return false;
  }
}

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const retiredPolicies = configuredAddresses(
    network,
    RETIRED_WHITELIST_POLICIES,
    "V3_GROUPS_CUTOVER_RETIRED_WHITELIST_POLICIES",
  );
  const retiredOrchestrators = configuredAddresses(
    network,
    RETIRED_ORCHESTRATORS,
    "V3_GROUPS_CUTOVER_RETIRED_ORCHESTRATORS",
  );
  const policy = await hre.deployments.getOrNull("WhitelistPolicy");
  const oldOrchestrator = await hre.deployments.getOrNull("OrchestratorV3");
  if (!policy) throw new Error("Run V2WhitelistPolicy and V3LifecycleStack together");
  if (retiredPolicies.some((address) => sameAddress(address, policy.address))) {
    throw new Error("WhitelistPolicy is still retired; delete both policy and O3 artifacts");
  }
  if (oldOrchestrator
    && retiredOrchestrators.some((address) => sameAddress(address, oldOrchestrator.address))) {
    throw new Error("OrchestratorV3 is still retired; delete both policy and O3 artifacts");
  }

  const preserved = await capturePreservedState(hre);
  const registry = await ethers.getContractAt(
    "OrchestratorRegistry",
    (await hre.deployments.get("OrchestratorRegistry")).address,
  );
  const registeredRetired: string[] = [];
  for (const address of retiredOrchestrators) {
    if (await registry.isOrchestrator(address)) registeredRetired.push(address);
  }
  const counters = await proveRetiredOrchestratorsDrained(hre, registeredRetired);

  console.log("=== Deploying whitelist-only V3 groups stack ===");
  console.log("Reusing WhitelistPolicy:", policy.address);
  console.log("Reusing UnifiedPaymentVerifierV3:", preserved.addresses.UnifiedPaymentVerifierV3);
  console.log("Reusing NullifierRegistryV2:", preserved.addresses.NullifierRegistryV2);
  console.log("Preserving ChargebackPolicy:", preserved.addresses.ChargebackPolicy);
  console.log("Preserving StakeVault:", preserved.addresses.StakeVault);

  const hook = await hre.deployments.deploy("WhitelistLifecycleHook", {
    from: deployer,
    args: [registry.address, policy.address],
    log: true,
  });
  if (hook.newlyDeployed) await waitForDeploymentDelay(hre);
  const orchestratorDeployment = await hre.deployments.deploy("OrchestratorV3", {
    from: deployer,
    args: [
      deployer,
      chainId,
      preserved.addresses.EscrowRegistry,
      preserved.addresses.PaymentVerifierRegistry,
      preserved.addresses.RelayerRegistry,
      ORCHESTRATOR_V3_PROTOCOL_FEE[network],
      ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network] || deployer,
    ],
    log: true,
  });
  if (orchestratorDeployment.newlyDeployed) await waitForDeploymentDelay(hre);

  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorDeployment.address);
  if (!sameAddress(await orchestrator.lifecycleHook(), hook.address)) {
    await (await orchestrator.setLifecycleHook(hook.address)).wait();
    await waitForDeploymentDelay(hre);
  }
  await addOrchestratorToRegistry(hre, registry, orchestrator.address);
  await proveRetiredOrchestratorsDrained(hre, registeredRetired, counters);
  for (const address of registeredRetired) {
    if (!sameAddress(address, orchestrator.address)) {
      await removeOrchestratorFromRegistry(hre, registry, address);
    }
  }
  await setNewOwner(hre, orchestrator, governance);
  await verifyCutover(hre, preserved, retiredOrchestrators, true);

  console.log("=== Whitelist-only V3 groups stack verified ===");
  console.log("WhitelistPolicy:", policy.address);
  console.log("WhitelistLifecycleHook:", hook.address);
  console.log("OrchestratorV3:", orchestrator.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!LIVE_NETWORKS.has(network)
    && !(LOCAL_NETWORKS.has(network) && process.env.ENABLE_V3_GROUPS_CUTOVER_TEST === "true")) {
    return true;
  }
  const policy = await hre.deployments.getOrNull("WhitelistPolicy");
  const orchestrator = await hre.deployments.getOrNull("OrchestratorV3");
  const hook = await hre.deployments.getOrNull("WhitelistLifecycleHook");
  const policyRetired = !!policy && configuredAddresses(
    network,
    RETIRED_WHITELIST_POLICIES,
    "V3_GROUPS_CUTOVER_RETIRED_WHITELIST_POLICIES",
  ).some((address) => sameAddress(address, policy.address));
  const orchestratorRetired = !!orchestrator && configuredAddresses(
    network,
    RETIRED_ORCHESTRATORS,
    "V3_GROUPS_CUTOVER_RETIRED_ORCHESTRATORS",
  ).some((address) => sameAddress(address, orchestrator.address));
  if (policyRetired && orchestratorRetired && !hook) return true;
  return fullyWired(hre);
};

func.tags = ["30_deploy_v3_lifecycle_stack", "V3LifecycleStack", "OrchestratorV3"];

export default func;
