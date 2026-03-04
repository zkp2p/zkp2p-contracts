import "module-alias/register";

import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers } from "hardhat";

import {
  MULTI_SIG,
  USDC
} from "../deployments/parameters";
import { getDeployedContractAddress } from "../deployments/helpers";
import { safeBatchCollector } from "../deployments/safeBatchCollector";

function tryGetAddress(network: string, contractName: string): string {
  try { return getDeployedContractAddress(network, contractName); } catch (e) { return "NOT DEPLOYED"; }
}

// Deployment Scripts
const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deploy } = await hre.deployments
  const network = hre.deployments.getNetworkName();
  const chainId = (await ethers.provider.getNetwork()).chainId;

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
    ----------------------------------------------------------------------
    V2 Contracts:
    OrchestratorRegistry:               ${tryGetAddress(network, "OrchestratorRegistry")}
    EscrowV2:                           ${tryGetAddress(network, "EscrowV2")}
    OrchestratorV2:                     ${tryGetAddress(network, "OrchestratorV2")}
    UnifiedPaymentVerifierV2:           ${tryGetAddress(network, "UnifiedPaymentVerifierV2")}
    WhitelistPreIntentHook:             ${tryGetAddress(network, "WhitelistPreIntentHook")}
    SignatureGatingPreIntentHook:       ${tryGetAddress(network, "SignatureGatingPreIntentHook")}
    AcrossBridgeHookV2:                 ${tryGetAddress(network, "AcrossBridgeHookV2")}
    RateManagerV1:                      ${tryGetAddress(network, "RateManagerV1")}
    ChainlinkOracleAdapter:             ${tryGetAddress(network, "ChainlinkOracleAdapter")}
    PythOracleAdapter:                  ${tryGetAddress(network, "PythOracleAdapter")}
    ProtocolViewerV2:                   ${tryGetAddress(network, "ProtocolViewerV2")}
    `
  );

  // Write Safe Transaction Builder batch file if there are pending multisig transactions
  const txCount = safeBatchCollector.count();
  if (txCount > 0) {
    const filePath = safeBatchCollector.writeBatchFile(
      network,
      chainId.toString(),
      multiSig
    );
    console.log(`\n    ======================================================================`);
    console.log(`    Safe Transaction Builder batch file written (${txCount} transactions):`);
    console.log(`    ${filePath}`);
    console.log(`    Upload this file to Safe UI > Transaction Builder to sign and execute.`);
    console.log(`    ======================================================================\n`);
  }
};

func.runAtTheEnd = true;

export default func;
