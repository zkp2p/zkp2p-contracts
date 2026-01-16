import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

const circom = require("circomlibjs");
import {
  MULTI_SIG,
  USDC
} from "../deployments/parameters";
import { getDeployedContractAddress, setNewOwner } from "../deployments/helpers";

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();

  const [deployer] = await hre.getUnnamedAccounts();
  const multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer;

  console.log(
    `
    Deploment summary for ${network}:
    deployer:                   ${deployer}
    deployer nonce:             ${await hre.ethers.provider.getTransactionCount(deployer)}
    multiSig:                   ${multiSig}
    multiSig nonce:             ${await hre.ethers.provider.getTransactionCount(multiSig)}
    ----------------------------------------------------------------------
    Escrow:                             ${getDeployedContractAddress(network, "Escrow")}
    Orchestrator:                       ${getDeployedContractAddress(network, "Orchestrator")}
    ProtocolViewer:                     ${getDeployedContractAddress(network, "ProtocolViewer")}
    EscrowRegistry:                     ${getDeployedContractAddress(network, "EscrowRegistry")}
    PaymentVerifierRegistry:            ${getDeployedContractAddress(network, "PaymentVerifierRegistry")}
    PostIntentHookRegistry:             ${getDeployedContractAddress(network, "PostIntentHookRegistry")}
    RelayerRegistry:                    ${getDeployedContractAddress(network, "RelayerRegistry")}
    NullifierRegistry:                  ${getDeployedContractAddress(network, "NullifierRegistry")}
    UnifiedPaymentVerifier:             ${getDeployedContractAddress(network, "UnifiedPaymentVerifier")}
    SimpleAttestationVerifier:          ${getDeployedContractAddress(network, "SimpleAttestationVerifier")}
    AcrossBridgeHook:                   ${getDeployedContractAddress(network, "AcrossBridgeHook")}
    USDC:                               ${USDC[network] ? USDC[network] : getDeployedContractAddress(network, "USDCMock")}
    `
  );
};

func.runAtTheEnd = true;

export default func;
