import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

import {
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
} from "../deployments/parameters";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();

  const initialWitnesses = MULTI_WITNESS_ADDRESSES[network];
  const initialThreshold = MULTI_WITNESS_THRESHOLD[network];

  if (!initialWitnesses || initialWitnesses.length === 0) {
    throw new Error(`No MultiAttestationVerifier witnesses configured for ${network}`);
  }

  if (!initialThreshold) {
    throw new Error(`No MultiAttestationVerifier threshold configured for ${network}`);
  }

  const multiAttestationVerifier = await deploy("MultiAttestationVerifier", {
    from: deployer,
    args: [initialWitnesses, initialThreshold],
  });

  console.log("MultiAttestationVerifier deployed at", multiAttestationVerifier.address);
};

func.tags = ["MultiAttestationVerifier"];

export default func;
