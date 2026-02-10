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

  const tryGetDeployedContractAddress = (contractName: string): string => {
    try {
      return getDeployedContractAddress(network, contractName);
    } catch (e) {
      return "NOT DEPLOYED";
    }
  };

  console.log(
    `
    Deploment summary for ${network}:
    deployer:                   ${deployer}
    deployer nonce:             ${await hre.ethers.provider.getTransactionCount(deployer)}
    multiSig:                   ${multiSig}
    multiSig nonce:             ${await hre.ethers.provider.getTransactionCount(multiSig)}
    ----------------------------------------------------------------------
    Escrow:                             ${tryGetDeployedContractAddress("Escrow")}
    Orchestrator:                       ${tryGetDeployedContractAddress("Orchestrator")}
    ProtocolViewer:                     ${tryGetDeployedContractAddress("ProtocolViewer")}
    EscrowRegistry:                     ${tryGetDeployedContractAddress("EscrowRegistry")}
    PaymentVerifierRegistry:            ${tryGetDeployedContractAddress("PaymentVerifierRegistry")}
    PostIntentHookRegistry:             ${tryGetDeployedContractAddress("PostIntentHookRegistry")}
    RelayerRegistry:                    ${tryGetDeployedContractAddress("RelayerRegistry")}
    NullifierRegistry:                  ${tryGetDeployedContractAddress("NullifierRegistry")}
    UnifiedPaymentVerifier:             ${tryGetDeployedContractAddress("UnifiedPaymentVerifier")}
    SimpleAttestationVerifier:          ${tryGetDeployedContractAddress("SimpleAttestationVerifier")}
    AcrossBridgeHook:                   ${tryGetDeployedContractAddress("AcrossBridgeHook")}
    ManualRateManagerRegistry:          ${tryGetDeployedContractAddress("ManualRateManagerRegistry")}
    OracleRateManagerRegistry:          ${tryGetDeployedContractAddress("OracleRateManagerRegistry")}
    ChainlinkOracleAdapter:             ${tryGetDeployedContractAddress("ChainlinkOracleAdapter")}
    DepositRateManagerController:       ${tryGetDeployedContractAddress("DepositRateManagerController")}
    DepositRateManagerHookV1:           ${tryGetDeployedContractAddress("DepositRateManagerHookV1")}
    USDC:                               ${USDC[network] ? USDC[network] : tryGetDeployedContractAddress("USDCMock")}
    `
  );
};

func.runAtTheEnd = true;

export default func;
