import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
} from "../deployments/parameters";
import {
  getDeployedContractAddress,
  setAttestationVerifier,
  setNewOwner,
} from "../deployments/helpers";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments;
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  const initialWitnesses = MULTI_WITNESS_ADDRESSES[network];
  const initialThreshold = MULTI_WITNESS_THRESHOLD[network];

  if (!initialWitnesses || initialWitnesses.length === 0) {
    throw new Error(`No MultiAttestationVerifier witnesses configured for ${network}`);
  }

  if (!initialThreshold) {
    throw new Error(`No MultiAttestationVerifier threshold configured for ${network}`);
  }

  // 1. Deploy MultiAttestationVerifier.
  const multiAttestationVerifier = await deploy("MultiAttestationVerifier", {
    from: deployer,
    args: [initialWitnesses, initialThreshold],
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

  // 3. Transfer MultiAttestationVerifier ownership to the multisig. On networks where the
  //    multisig is the deployer (localhost, base_staging) this is a no-op.
  const multiAttestationVerifierContract = await ethers.getContractAt(
    "MultiAttestationVerifier",
    multiAttestationVerifier.address
  );
  await setNewOwner(hre, multiAttestationVerifierContract, multiSig);
  console.log("MultiAttestationVerifier ownership transferred to", multiSig);
};

func.tags = ["MultiAttestationVerifier"];

export default func;
