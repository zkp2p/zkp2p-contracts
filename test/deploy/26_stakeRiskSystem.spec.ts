import "module-alias/register";

import { expect } from "chai";
import { deployments, ethers } from "hardhat";

import historicalStakeRiskDeployment from "../../deploy/26_deploy_stake_risk_system";
import { paidExtensionPolicyForNetwork } from "../../deploy/28_deploy_paid_extension_stake_risk_system";
import { MULTI_SIG, STAKE_RISK_PLATFORM_POLICY } from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Stake risk deployment cutover", () => {
  const network = deployments.getNetworkName();
  const policy = paidExtensionPolicyForNetwork(network);

  function deployedAddress(contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  it("cannot execute the removed griefing deployment", async () => {
    expect(historicalStakeRiskDeployment.skip).not.to.eq(undefined);
    expect(await historicalStakeRiskDeployment.skip!({} as any)).to.eq(true);
    expect(STAKE_RISK_PLATFORM_POLICY.base).to.eq(undefined);
  });

  it("deploys the current V3 risk components with only historical library links", async () => {
    expect(deployedAddress("BoundedCall")).to.properAddress;
    expect(deployedAddress("PostIntentHookExecutor")).to.properAddress;
    expect(deployedAddress("OrchestratorV3")).to.properAddress;
    expect(deployedAddress("StakeVault")).to.properAddress;
    expect(deployedAddress("RiskManager")).to.properAddress;
    expect(deployedAddress("DeferredPayoutHook")).to.properAddress;
  });

  it("wires the risk components and registers the orchestrator", async () => {
    const vault = await ethers.getContractAt("StakeVault", deployedAddress("StakeVault"));
    const manager = await ethers.getContractAt("RiskManager", deployedAddress("RiskManager"));
    const registry = await ethers.getContractAt("OrchestratorRegistry", deployedAddress("OrchestratorRegistry"));

    expect(await vault.controller()).to.eq(manager.address);
    expect(await manager.orchestrator()).to.eq(deployedAddress("OrchestratorV3"));
    expect(await manager.stakeVault()).to.eq(vault.address);
    expect(await registry.isOrchestrator(deployedAddress("OrchestratorV3"))).to.eq(true);
  });

  it("sets the 20% APR and five-day cap without a non-chargeback base tranche", async () => {
    const manager = await ethers.getContractAt("RiskManager", deployedAddress("RiskManager"));
    const reversible = await manager.getPlatformRiskConfig(PAYPAL);
    const nonChargebackable = await manager.getPlatformRiskConfig(ZELLE);

    expect(reversible.extension.feeBps).to.eq(policy.reversible.extension.feeBps);
    expect(reversible.extension.maxIntentLifetime).to.eq(policy.reversible.extension.maxIntentLifetime);
    expect(nonChargebackable.chargeback.reserveBps).to.eq(0);
    expect(nonChargebackable.extension.feeBps).to.eq(policy.nonChargebackable.extension.feeBps);
    expect(nonChargebackable.extension.maxIntentLifetime)
      .to.eq(policy.nonChargebackable.extension.maxIntentLifetime);
  });

  it("transfers ownership and keeps production policy disabled", async () => {
    const [deployer] = await ethers.getSigners();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    const orchestrator = await ethers.getContractAt("OrchestratorV3", deployedAddress("OrchestratorV3"));
    const vault = await ethers.getContractAt("StakeVault", deployedAddress("StakeVault"));
    const manager = await ethers.getContractAt("RiskManager", deployedAddress("RiskManager"));

    expect(await orchestrator.owner()).to.eq(expectedOwner);
    expect(await vault.owner()).to.eq(expectedOwner);
    expect(await manager.owner()).to.eq(expectedOwner);
    expect(() => paidExtensionPolicyForNetwork("base")).to.throw(
      "No governance-ratified paid-extension policy for network: base",
    );
  });
});
