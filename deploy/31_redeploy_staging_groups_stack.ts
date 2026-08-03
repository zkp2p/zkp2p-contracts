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
  getDeployedContractAddress,
  removeOrchestratorFromRegistry,
  setNewOwner,
  waitForDeploymentDelay,
} from "../deployments/helpers";
import { postGraphql } from "../scripts/rawGraphql";

const SUPPORTED_NETWORKS = new Set(["base_staging"]);
const LOCAL_TEST_NETWORKS = new Set(["localhost", "hardhat"]);
const TEMPORARY_DEPLOYMENT_NAMES = {
  OrchestratorV3: "OrchestratorV3GroupsCutover",
  WhitelistPolicy: "WhitelistPolicyGroupsCutover",
  WhitelistLifecycleHook: "WhitelistLifecycleHookGroupsCutover",
} as const;

/**
 * Historical Base-staging OrchestratorV3 deployments that must not retain registry authorization
 * after the whitelist-only cutover. The current canonical deployment artifact is added to this
 * set dynamically before it is superseded.
 */
export const RETIRED_BASE_STAGING_ORCHESTRATORS = [
  "0x6Db9dDb38a19Be0c614C0Ad9e78Baf73f93c35dF",
  "0xF9CEE6365fB4F6354a19e95d35aaeF877CF1179d",
  "0x1734f5C9956D0DA1f48E27cd1C6167aA81F27869",
];

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function uniqueAddresses(addresses: string[]): string[] {
  return [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
}

function isSupportedNetwork(network: string): boolean {
  return SUPPORTED_NETWORKS.has(network)
    || (
      LOCAL_TEST_NETWORKS.has(network)
      && process.env.ENABLE_STAGING_GROUPS_CUTOVER_TEST === "true"
    );
}

async function deployFreshCandidate(
  hre: HardhatRuntimeEnvironment,
  canonicalName: string,
  contractName: string,
  args: unknown[],
) {
  const { deploy } = hre.deployments;
  const [deployer] = await hre.getUnnamedAccounts();
  const temporaryName = `${canonicalName}GroupsCutover`;

  // A temporary deployment name forces a fresh CREATE even when the canonical bytecode and
  // constructor arguments are unchanged. If an interrupted run left the temporary artifact,
  // hardhat-deploy reuses it so resuming does not create a duplicate contract.
  const deployment = await deploy(temporaryName, {
    contract: contractName,
    from: deployer,
    args,
    log: true,
  });
  if (deployment.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  return deployment;
}

function retiredOrchestratorsForNetwork(network: string, previousAddress?: string): string[] {
  const configured = network === "base_staging" ? RETIRED_BASE_STAGING_ORCHESTRATORS : [];
  return uniqueAddresses([...(previousAddress ? [previousAddress] : []), ...configured]);
}

async function assertRetiredOrchestratorsDrained(
  hre: HardhatRuntimeEnvironment,
  retiredAddresses: string[],
  expectedIntentCounters?: Map<string, string>,
): Promise<Map<string, string>> {
  const network = hre.deployments.getNetworkName();
  const intentCounters = new Map<string, string>();
  if (network !== "base_staging" || retiredAddresses.length === 0) return intentCounters;

  const endpoint = process.env.GROUPS_CUTOVER_INDEXER_GRAPHQL_URL;
  if (!endpoint) {
    throw new Error(
      "GROUPS_CUTOVER_INDEXER_GRAPHQL_URL is required to prove retired staging orchestrators are drained",
    );
  }

  for (const retiredAddress of retiredAddresses) {
    if ((await ethers.provider.getCode(retiredAddress)) === "0x") {
      throw new Error(`Registered retired OrchestratorV3 has no bytecode: ${retiredAddress}`);
    }
    const retired = new ethers.Contract(
      retiredAddress,
      ["function intentCounter() view returns (uint256)"],
      ethers.provider,
    );
    const intentCounter = (await retired.intentCounter()).toString();
    const addressKey = retiredAddress.toLowerCase();
    intentCounters.set(addressKey, intentCounter);
    const expectedIntentCounter = expectedIntentCounters?.get(addressKey);
    if (expectedIntentCounter !== undefined && expectedIntentCounter !== intentCounter) {
      throw new Error(
        `Retired OrchestratorV3 ${retiredAddress} signaled an intent during the cutover`,
      );
    }

    const data = await postGraphql<{
      indexed: Array<{ id: string }>;
      pending: Array<{ id: string }>;
    }>(
      endpoint,
      `query RetiredOrchestratorDrain($orchestrator: String!) {
        indexed: Intent(
          where: { orchestratorAddress: { _eq: $orchestrator } }
          limit: 1
        ) {
          id
        }
        pending: Intent(
          where: {
            orchestratorAddress: { _eq: $orchestrator }
            status: { _eq: SIGNALED }
          }
          limit: 1
        ) {
          id
        }
      }`,
      { orchestrator: retiredAddress.toLowerCase() },
      process.env.GROUPS_CUTOVER_INDEXER_API_KEY,
    );
    if (!Array.isArray(data.indexed) || !Array.isArray(data.pending)) {
      throw new Error("Indexer returned invalid Intent results while checking a retired orchestrator");
    }
    if (data.pending.length !== 0) {
      throw new Error(`Retired OrchestratorV3 ${retiredAddress} still has a SIGNALED intent`);
    }

    // The current staging indexer does not index every historical O3 address. Absence of rows is
    // therefore not a drain proof by itself; an unindexed deployment must never have signaled.
    if (data.indexed.length === 0 && intentCounter !== "0") {
      throw new Error(
        `Unindexed retired OrchestratorV3 ${retiredAddress} has signaled intents; drain is unproven`,
      );
    }
  }
  return intentCounters;
}

/**
 * Verifies the complete whitelist-only cutover without relying on package exports.
 * Throws on the first mismatch so deployment and standalone verification fail closed.
 */
export async function assertGroupsCutoverWiring(hre: HardhatRuntimeEnvironment): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (!isSupportedNetwork(network)) {
    throw new Error(`Groups cutover is not supported on network ${network}`);
  }

  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;
  const orchestratorV3 = await hre.deployments.get("OrchestratorV3");
  const whitelistPolicy = await hre.deployments.get("WhitelistPolicy");
  const whitelistLifecycleHook = await hre.deployments.get("WhitelistLifecycleHook");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const addressGroupRegistryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");

  for (const [name, address] of [
    ["OrchestratorV3", orchestratorV3.address],
    ["WhitelistPolicy", whitelistPolicy.address],
    ["WhitelistLifecycleHook", whitelistLifecycleHook.address],
  ]) {
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${name} has no deployed bytecode at ${address}`);
    }
  }

  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const policy = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  const lifecycleHook = await ethers.getContractAt("WhitelistLifecycleHook", whitelistLifecycleHook.address);
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);

  if (!sameAddress(await orchestrator.lifecycleHook(), whitelistLifecycleHook.address)) {
    throw new Error("OrchestratorV3 lifecycle hook does not match WhitelistLifecycleHook");
  }
  if (!sameAddress(await lifecycleHook.orchestratorRegistry(), orchestratorRegistryAddress)) {
    throw new Error("WhitelistLifecycleHook orchestrator registry mismatch");
  }
  if (!sameAddress(await lifecycleHook.whitelistPolicy(), whitelistPolicy.address)) {
    throw new Error("WhitelistLifecycleHook policy mismatch");
  }
  if (!sameAddress(await policy.groupRegistry(), addressGroupRegistryAddress)) {
    throw new Error("WhitelistPolicy address group registry mismatch");
  }
  if (!sameAddress(await policy.escrowRegistry(), escrowRegistryAddress)) {
    throw new Error("WhitelistPolicy escrow registry mismatch");
  }
  if (!sameAddress(await policy.orchestratorRegistry(), orchestratorRegistryAddress)) {
    throw new Error("WhitelistPolicy orchestrator registry mismatch");
  }
  if (!sameAddress(await orchestrator.owner(), governance)) {
    throw new Error(`OrchestratorV3 owner mismatch: expected ${governance}`);
  }
  if (!sameAddress(await policy.owner(), governance)) {
    throw new Error(`WhitelistPolicy owner mismatch: expected ${governance}`);
  }
  if (!(await orchestratorRegistry.isOrchestrator(orchestratorV3.address))) {
    throw new Error("OrchestratorV3 is not authorized in OrchestratorRegistry");
  }

  for (const retiredAddress of retiredOrchestratorsForNetwork(network)) {
    if (
      !sameAddress(retiredAddress, orchestratorV3.address)
      && (await orchestratorRegistry.isOrchestrator(retiredAddress))
    ) {
      throw new Error(`Retired OrchestratorV3 remains authorized: ${retiredAddress}`);
    }
  }

  // These components are intentionally outside this cutover. Requiring their existing bytecode
  // guards against accidentally replacing the broader lifecycle stack with partial artifacts.
  for (const preservedName of ["UnifiedPaymentVerifierV3", "NullifierRegistryV2", "ChargebackPolicy"]) {
    const preserved = await hre.deployments.get(preservedName);
    if ((await ethers.provider.getCode(preserved.address)) === "0x") {
      throw new Error(`Preserved ${preservedName} has no deployed bytecode at ${preserved.address}`);
    }
  }
}

async function systemFullyWired(hre: HardhatRuntimeEnvironment): Promise<boolean> {
  try {
    await assertGroupsCutoverWiring(hre);
    for (const temporaryName of Object.values(TEMPORARY_DEPLOYMENT_NAMES)) {
      if (await hre.deployments.getOrNull(temporaryName)) return false;
    }
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

  // A canonical hook exists only after all three candidates have been wired and promoted. Any
  // read or wiring mismatch at that point must fail closed: treating it as a fresh deployment
  // could abandon a correctly deployed stack during a transient RPC failure.
  const canonicalWhitelistLifecycleHook = await hre.deployments.getOrNull("WhitelistLifecycleHook");
  if (canonicalWhitelistLifecycleHook) {
    await assertGroupsCutoverWiring(hre);
    for (const temporaryName of Object.values(TEMPORARY_DEPLOYMENT_NAMES)) {
      await hre.deployments.delete(temporaryName);
    }
    console.log("Groups cutover already wired; removed leftover temporary deployment aliases");
    return;
  }

  const previousOrchestratorV3 = await hre.deployments.getOrNull("OrchestratorV3");
  const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
  const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
  const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
  const relayerRegistryAddress = getDeployedContractAddress(network, "RelayerRegistry");
  const addressGroupRegistryAddress = getDeployedContractAddress(network, "AddressGroupRegistry");
  const orchestratorRegistry = await ethers.getContractAt("OrchestratorRegistry", orchestratorRegistryAddress);
  const registeredRetiredOrchestrators: string[] = [];
  for (const retiredAddress of retiredOrchestratorsForNetwork(network, previousOrchestratorV3?.address)) {
    if (await orchestratorRegistry.isOrchestrator(retiredAddress)) {
      registeredRetiredOrchestrators.push(retiredAddress);
    }
  }
  const retiredIntentCounters = await assertRetiredOrchestratorsDrained(
    hre,
    registeredRetiredOrchestrators,
  );

  console.log("=== Fresh whitelist-only groups cutover ===");
  console.log("Reusing AddressGroupRegistry:", addressGroupRegistryAddress);
  console.log("Reusing EscrowRegistry:", escrowRegistryAddress);
  console.log("Reusing OrchestratorRegistry:", orchestratorRegistryAddress);
  console.log("Reusing PaymentVerifierRegistry:", paymentVerifierRegistryAddress);
  console.log("Reusing RelayerRegistry:", relayerRegistryAddress);

  const whitelistPolicy = await deployFreshCandidate(
    hre,
    "WhitelistPolicy",
    "WhitelistPolicy",
    [addressGroupRegistryAddress, escrowRegistryAddress, orchestratorRegistryAddress],
  );
  const whitelistLifecycleHook = await deployFreshCandidate(
    hre,
    "WhitelistLifecycleHook",
    "WhitelistLifecycleHook",
    [orchestratorRegistryAddress, whitelistPolicy.address],
  );
  const orchestratorV3 = await deployFreshCandidate(
    hre,
    "OrchestratorV3",
    "OrchestratorV3",
    [
      deployer,
      chainId,
      escrowRegistryAddress,
      paymentVerifierRegistryAddress,
      relayerRegistryAddress,
      ORCHESTRATOR_V3_PROTOCOL_FEE[network],
      ORCHESTRATOR_V3_PROTOCOL_FEE_RECIPIENT[network] || deployer,
    ],
  );

  const orchestrator = await ethers.getContractAt("OrchestratorV3", orchestratorV3.address);
  const policy = await ethers.getContractAt("WhitelistPolicy", whitelistPolicy.address);
  await (await orchestrator.setLifecycleHook(whitelistLifecycleHook.address)).wait();
  await waitForDeploymentDelay(hre);
  await addOrchestratorToRegistry(hre, orchestratorRegistry, orchestratorV3.address);

  // Repeat the drain proof immediately before deregistration to close the deployment-time gap.
  await assertRetiredOrchestratorsDrained(
    hre,
    registeredRetiredOrchestrators,
    retiredIntentCounters,
  );
  for (const retiredAddress of registeredRetiredOrchestrators) {
    if (!sameAddress(retiredAddress, orchestratorV3.address)) {
      await removeOrchestratorFromRegistry(hre, orchestratorRegistry, retiredAddress);
    }
  }

  await setNewOwner(hre, orchestrator, governance);
  await setNewOwner(hre, policy, governance);

  // Promote all three candidates to canonical artifacts only after the live wiring succeeds.
  // Temporary aliases remain available across interrupted runs and are removed only after the
  // canonical artifacts and post-deploy verification all agree.
  await hre.deployments.save("WhitelistPolicy", whitelistPolicy);
  await hre.deployments.save("WhitelistLifecycleHook", whitelistLifecycleHook);
  await hre.deployments.save("OrchestratorV3", orchestratorV3);
  await assertGroupsCutoverWiring(hre);
  for (const temporaryName of Object.values(TEMPORARY_DEPLOYMENT_NAMES)) {
    await hre.deployments.delete(temporaryName);
  }

  console.log("=== Whitelist-only groups cutover verified ===");
  console.log("OrchestratorV3:", orchestratorV3.address);
  console.log("WhitelistPolicy:", whitelistPolicy.address);
  console.log("WhitelistLifecycleHook:", whitelistLifecycleHook.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!isSupportedNetwork(network)) return true;
  if (process.env.FORCE_RERUN_STAGING_GROUPS_CUTOVER === "true") return false;
  return systemFullyWired(hre);
};

func.tags = ["31_redeploy_staging_groups_stack", "StagingGroupsCutover"];

export default func;
