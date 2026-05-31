import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  getDeployedContractAddress,
  setAttestationVerifier,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();

  // 1. Deploy MultiAttestationVerifier.
  const multiAttestationVerifier = await deploy("MultiAttestationVerifier", {
    from: deployer,
    args: [],
  });
  console.log("MultiAttestationVerifier deployed at", multiAttestationVerifier.address);

  // 2. Wire MultiAttestationVerifier into UnifiedPaymentVerifierV2.
  //    On networks where the deployer still owns UPV-V2 (localhost, base_staging) this
  //    is a direct transaction. On networks where UPV-V2 has already been transferred to
  //    the multisig (base), the helper appends the call to safeBatchCollector so
  //    deploy_summary.ts writes a Safe Transaction Builder batch for later execution.
  // UnifiedPaymentVerifierV2 is a hardhat-deploy name for the same `UnifiedPaymentVerifier`
  // contract. Attach the V1 artifact to get the `setAttestationVerifier` / `attestationVerifier`
  // ABI — same pattern used by deploy/14_deploy_v2_system.ts and test/deploy/14_v2System.spec.ts.
  const upvV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
  const upvV2 = await ethers.getContractAt("UnifiedPaymentVerifier", upvV2Address);
  await setAttestationVerifier(hre, upvV2, multiAttestationVerifier.address);
};

func.tags = ["MultiAttestationVerifier"];

export default func;
