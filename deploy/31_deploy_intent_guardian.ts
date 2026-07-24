import "module-alias/register";

import {HardhatRuntimeEnvironment} from "hardhat/types";
import {DeployFunction} from "hardhat-deploy/types";

import {
  INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR,
  MULTI_SIG,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  waitForDeploymentDelay,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const {deploy} = hre.deployments;
  const network = hre.deployments.getNetworkName();
  const [deployer] = await hre.getUnnamedAccounts();
  const owner = MULTI_SIG[network] || deployer;
  const extensionFeeBpsPerHour = INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network];

  if (extensionFeeBpsPerHour === undefined) {
    throw new Error(`No initial IntentGuardian fee configured for network: ${network}`);
  }

  const escrowRegistry = getDeployedContractAddress(network, "EscrowRegistry");
  const guardian = await deploy("IntentGuardian", {
    from: deployer,
    args: [owner, escrowRegistry, extensionFeeBpsPerHour],
    log: true,
  });

  if (guardian.newlyDeployed) {
    console.log(
      "IntentGuardian deployed at",
      guardian.address,
      "with governance owner",
      owner,
      "and initial fee",
      extensionFeeBpsPerHour,
      "bps/hour",
    );
    await waitForDeploymentDelay(hre);
  }
};

func.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  const network = hre.deployments.getNetworkName();
  return INTENT_GUARDIAN_EXTENSION_FEE_BPS_PER_HOUR[network] === undefined;
};

func.tags = ["31_deploy_intent_guardian", "IntentGuardian"];
func.dependencies = ["14_deploy_v2_system"];

export default func;
