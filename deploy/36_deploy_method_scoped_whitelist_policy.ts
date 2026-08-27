import "module-alias/register";

import { ethers } from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import { assertCanonicalDeployment } from "../deployments/canonicalDeployment";
import { setNewOwner, waitForDeploymentDelay } from "../deployments/helpers";
import { MULTI_SIG } from "../deployments/parameters";
import type { WhitelistPolicy__factory } from "../typechain";

export const SUPPORTED_NETWORKS = new Set([
  "localhost",
  "hardhat",
  "base_staging",
  "base",
]);

export const METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME =
  "WhitelistPolicyMethodScoped";

export const ARTIFACT_NAMES = {
  [METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME]: "WhitelistPolicy",
} as const;

type LiveNetwork = "base" | "base_staging";

export const EXPECTED_LIVE: Record<
  LiveNetwork,
  {
    deployer: string;
    governance: string;
    orchestratorRegistry: string;
    escrowRegistry: string;
    addressGroupRegistry: string;
  }
> = {
  base: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    governance: MULTI_SIG.base,
    orchestratorRegistry: "0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9",
    escrowRegistry: "0xeD0e847B101abc96E796260AC358e12BAa2f5B21",
    addressGroupRegistry: "0x39F80118f9eB619135f116171b6Cb91D372C5AF2",
  },
  base_staging: {
    deployer: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    governance: "0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929",
    orchestratorRegistry: "0xfA6384EB6176cfEC049540526A3d2126C3666d8A",
    escrowRegistry: "0xc545f336eC77E69bf115729acCbf2e557A00ac91",
    addressGroupRegistry: "0x54Ff7788Cb42B46FE2F016a65Fd0f654Bb9BcF3D",
  },
};

const LIVE_FLAGS: Record<LiveNetwork, string> = {
  base_staging: "ENABLE_STAGING_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT",
  base: "ENABLE_BASE_METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT",
};

function isLiveNetwork(network: string): network is LiveNetwork {
  return network === "base" || network === "base_staging";
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertAddress(label: string, actual: string, expected: string): void {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label} address mismatch`);
  }
}

async function readDependencies(hre: HardhatRuntimeEnvironment): Promise<{
  addressGroupRegistry: string;
  escrowRegistry: string;
  orchestratorRegistry: string;
  orchestratorV2: string;
  escrowV2: string;
}> {
  const [
    addressGroupRegistry,
    escrowRegistry,
    orchestratorRegistry,
    orchestratorV2,
    escrowV2,
  ] = await Promise.all([
    hre.deployments.get("AddressGroupRegistry"),
    hre.deployments.get("EscrowRegistry"),
    hre.deployments.get("OrchestratorRegistry"),
    hre.deployments.get("OrchestratorV2"),
    hre.deployments.get("EscrowV2"),
  ]);
  return {
    addressGroupRegistry: addressGroupRegistry.address,
    escrowRegistry: escrowRegistry.address,
    orchestratorRegistry: orchestratorRegistry.address,
    orchestratorV2: orchestratorV2.address,
    escrowV2: escrowV2.address,
  };
}

async function assertRegistryState(
  dependencies: Awaited<ReturnType<typeof readDependencies>>
): Promise<void> {
  const orchestratorRegistry = await ethers.getContractAt(
    "OrchestratorRegistry",
    dependencies.orchestratorRegistry
  );
  const escrowRegistry = await ethers.getContractAt(
    "EscrowRegistry",
    dependencies.escrowRegistry
  );
  if (
    !(await orchestratorRegistry.isOrchestrator(dependencies.orchestratorV2))
  ) {
    throw new Error("OrchestratorV2 must already be registered");
  }
  if (!(await escrowRegistry.isWhitelistedEscrow(dependencies.escrowV2))) {
    throw new Error("EscrowV2 must already be whitelisted");
  }
}

async function assertLivePreconditions(
  hre: HardhatRuntimeEnvironment,
  network: LiveNetwork,
  dependencies: Awaited<ReturnType<typeof readDependencies>>
): Promise<void> {
  const expected = EXPECTED_LIVE[network];
  const [deployer] = await hre.getUnnamedAccounts();
  assertAddress("Deployment signer", deployer, expected.deployer);
  assertAddress(
    "AddressGroupRegistry",
    dependencies.addressGroupRegistry,
    expected.addressGroupRegistry
  );
  assertAddress(
    "EscrowRegistry",
    dependencies.escrowRegistry,
    expected.escrowRegistry
  );
  assertAddress(
    "OrchestratorRegistry",
    dependencies.orchestratorRegistry,
    expected.orchestratorRegistry
  );
  assertAddress(
    "Governance",
    MULTI_SIG[network] || deployer,
    expected.governance
  );
  await assertRegistryState(dependencies);
}

async function assertPolicyWiring(
  policyAddress: string,
  governance: string,
  dependencies: Awaited<ReturnType<typeof readDependencies>>
): Promise<void> {
  const policy = await ethers.getContractAt("WhitelistPolicy", policyAddress);
  assertAddress(
    "WhitelistPolicyMethodScoped group registry",
    await policy.groupRegistry(),
    dependencies.addressGroupRegistry
  );
  assertAddress(
    "WhitelistPolicyMethodScoped escrow registry",
    await policy.escrowRegistry(),
    dependencies.escrowRegistry
  );
  assertAddress(
    "WhitelistPolicyMethodScoped orchestrator registry",
    await policy.orchestratorRegistry(),
    dependencies.orchestratorRegistry
  );
  assertAddress(
    "WhitelistPolicyMethodScoped owner",
    await policy.owner(),
    governance
  );
}

const func: DeployFunction = async function (
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const network = hre.deployments.getNetworkName();
  if (isLiveNetwork(network) && process.env[LIVE_FLAGS[network]] !== "true") {
    throw new Error(
      `${network} method-scoped whitelist policy deployment requires ${LIVE_FLAGS[network]}=true`
    );
  }
  const [deployer] = await hre.getUnnamedAccounts();
  const governance = MULTI_SIG[network] || deployer;

  const dependencies = await readDependencies(hre);
  if (isLiveNetwork(network)) {
    await assertLivePreconditions(hre, network, dependencies);
  } else {
    await assertRegistryState(dependencies);
  }

  console.log("=== Deploying method-scoped whitelist policy ===");
  console.log("Reusing OrchestratorV2:", dependencies.orchestratorV2);
  console.log("Reusing EscrowV2:", dependencies.escrowV2);

  const existing = await hre.deployments.getOrNull(
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
  );
  if (existing) {
    await assertCanonicalDeployment(
      hre,
      existing,
      METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
      ARTIFACT_NAMES[METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME]
    );
  }

  const whitelistPolicyArgs: Parameters<WhitelistPolicy__factory["deploy"]> = [
    dependencies.addressGroupRegistry,
    dependencies.escrowRegistry,
    dependencies.orchestratorRegistry,
  ];
  const whitelistPolicy = existing
    ? existing
    : await hre.deployments.deploy(
        METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
        {
          contract:
            ARTIFACT_NAMES[METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME],
          from: deployer,
          args: whitelistPolicyArgs,
          log: true,
        }
      );
  if ("newlyDeployed" in whitelistPolicy && whitelistPolicy.newlyDeployed) {
    await waitForDeploymentDelay(hre);
  }

  const policy = await ethers.getContractAt(
    "WhitelistPolicy",
    whitelistPolicy.address
  );
  assertAddress(
    "WhitelistPolicyMethodScoped group registry",
    await policy.groupRegistry(),
    dependencies.addressGroupRegistry
  );
  assertAddress(
    "WhitelistPolicyMethodScoped escrow registry",
    await policy.escrowRegistry(),
    dependencies.escrowRegistry
  );
  assertAddress(
    "WhitelistPolicyMethodScoped orchestrator registry",
    await policy.orchestratorRegistry(),
    dependencies.orchestratorRegistry
  );
  await setNewOwner(hre, policy, governance);
  await assertPolicyWiring(whitelistPolicy.address, governance, dependencies);

  console.log("=== Method-scoped whitelist policy deployment prepared ===");
  console.log("AddressGroupRegistry:", dependencies.addressGroupRegistry);
  console.log("WhitelistPolicyMethodScoped:", whitelistPolicy.address);
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  if (!SUPPORTED_NETWORKS.has(network)) return true;
  if (!isLiveNetwork(network)) return false;

  const existing = await hre.deployments.getOrNull(
    METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME
  );
  if (existing) {
    await assertCanonicalDeployment(
      hre,
      existing,
      METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME,
      ARTIFACT_NAMES[METHOD_SCOPED_WHITELIST_POLICY_DEPLOYMENT_NAME]
    );
    const dependencies = await readDependencies(hre);
    await assertLivePreconditions(hre, network, dependencies);
    const [deployer] = await hre.getUnnamedAccounts();
    await assertPolicyWiring(
      existing.address,
      MULTI_SIG[network] || deployer,
      dependencies
    );
    return true;
  }

  const flag = LIVE_FLAGS[network];
  if (process.env[flag] !== "true") {
    if (
      process.env.DEPLOY_ACTIVE_TAG ===
      "36_deploy_method_scoped_whitelist_policy"
    ) {
      throw new Error(
        `${network} method-scoped whitelist policy deployment requires ${flag}=true; set the flag and retry`
      );
    }
    return true;
  }
  return false;
};

func.tags = [
  "36_deploy_method_scoped_whitelist_policy",
  "MethodScopedWhitelistPolicy",
];
// Keep tagged runs from pulling lane 16 through 29 -> 28; full local ordering comes from filenames.
func.dependencies = [];

export default func;
