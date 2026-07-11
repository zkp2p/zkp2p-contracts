import "module-alias/register";

import { expect } from "chai";
import hre, { deployments, ethers, getUnnamedAccounts } from "hardhat";

import deployOnchainRiskSystem from "../../deploy/26_deploy_onchain_risk_system";
import {
  CHARGEBACK_ATTESTOR_ADDRESSES,
  IDENTITY_ATTESTOR_ADDRESSES,
  MULTI_SIG,
} from "../../deployments/parameters";
import { PAYPAL_PAYMENT_METHOD_HASH } from "../../deployments/verifiers/paypal";
import { WISE_PAYMENT_METHOD_HASH } from "../../deployments/verifiers/wise";

describe("Onchain risk system dark deployment", () => {
  const network = deployments.getNetworkName();
  const deploymentNames = [
    "OrchestratorRegistry",
    "EscrowRegistry",
    "PaymentVerifierRegistry",
    "RelayerRegistry",
    "USDCMock",
    "IdentityRegistry",
    "ReputationRegistry",
    "StakeVault",
    "ProtocolRiskManager",
    "OpenOrchestratorV2",
  ];

  before(async () => {
    process.env.DEPLOY_ONCHAIN_RISK = "true";
    for (const name of deploymentNames) await deployments.delete(name);
    const saveDependency = async (name: string, args: any[] = []): Promise<void> => {
      const factory = await ethers.getContractFactory(name);
      const contract = await factory.deploy(...args);
      await contract.deployed();
      const artifact = await deployments.getArtifact(name);
      await deployments.save(name, { address: contract.address, abi: artifact.abi });
    };

    await saveDependency("OrchestratorRegistry");
    await saveDependency("EscrowRegistry");
    await saveDependency("PaymentVerifierRegistry");
    await saveDependency("RelayerRegistry");
    await saveDependency("USDCMock", [ethers.utils.parseUnits("1000000", 6), "USDC", "USDC"]);
    await deployOnchainRiskSystem(hre);
    await deployOnchainRiskSystem(hre); // Idempotent retry must preserve the dark-deploy state.
  });

  after(async () => {
    delete process.env.DEPLOY_ONCHAIN_RISK;
    for (const name of deploymentNames) await deployments.delete(name);
  });

  it("registers only a paused open orchestrator with its risk manager wired", async () => {
    const openDeployment = await deployments.get("OpenOrchestratorV2");
    const riskDeployment = await deployments.get("ProtocolRiskManager");
    const registryDeployment = await deployments.get("OrchestratorRegistry");
    const orchestrator = await ethers.getContractAt("OrchestratorV2", openDeployment.address);
    const registry = await ethers.getContractAt("OrchestratorRegistry", registryDeployment.address);

    expect(await orchestrator.paused()).to.equal(true);
    expect(await orchestrator.riskManager()).to.equal(riskDeployment.address);
    expect(await registry.isOrchestrator(openDeployment.address)).to.equal(true);
  });

  it("keeps representative reversible and irreversible platform configs disabled", async () => {
    const riskDeployment = await deployments.get("ProtocolRiskManager");
    const riskManager = await ethers.getContractAt("ProtocolRiskManager", riskDeployment.address);
    const reversible = await riskManager.platformRiskConfigs(PAYPAL_PAYMENT_METHOD_HASH);
    const irreversible = await riskManager.platformRiskConfigs(WISE_PAYMENT_METHOD_HASH);

    expect(reversible.configured).to.equal(true);
    expect(reversible.enabled).to.equal(false);
    expect(reversible.chargebackable).to.equal(true);
    expect(reversible.baseStakeBps).to.equal(10_000);
    expect(irreversible.configured).to.equal(true);
    expect(irreversible.enabled).to.equal(false);
    expect(irreversible.chargebackable).to.equal(false);
    expect(irreversible.baseStakeBps).to.equal(0);
  });

  it("wires reporters, witnesses, and multisig ownership", async () => {
    const [deployer] = await getUnnamedAccounts();
    const expectedOwner = MULTI_SIG[network] || deployer;
    const identityDeployment = await deployments.get("IdentityRegistry");
    const reputationDeployment = await deployments.get("ReputationRegistry");
    const vaultDeployment = await deployments.get("StakeVault");
    const riskDeployment = await deployments.get("ProtocolRiskManager");
    const openDeployment = await deployments.get("OpenOrchestratorV2");
    const identity = await ethers.getContractAt("IdentityRegistry", identityDeployment.address);
    const reputation = await ethers.getContractAt("ReputationRegistry", reputationDeployment.address);
    const vault = await ethers.getContractAt("StakeVault", vaultDeployment.address);
    const riskManager = await ethers.getContractAt("ProtocolRiskManager", riskDeployment.address);
    const orchestrator = await ethers.getContractAt("OrchestratorV2", openDeployment.address);

    expect(await reputation.authorizedUpdaters(riskDeployment.address)).to.equal(true);
    expect(await vault.authorizedManagers(riskDeployment.address)).to.equal(true);
    for (const witness of IDENTITY_ATTESTOR_ADDRESSES[network] || []) {
      expect(await identity.trustedAttestors(witness)).to.equal(true);
      expect(await riskManager.trustedChargebackAttestors(witness)).to.equal(false);
    }
    for (const witness of CHARGEBACK_ATTESTOR_ADDRESSES[network] || []) {
      expect(await riskManager.trustedChargebackAttestors(witness)).to.equal(true);
      expect(await identity.trustedAttestors(witness)).to.equal(false);
    }
    for (const actionType of ["register_venmo", "register_paypal", "register_wise", "register_cashapp"]) {
      const actionTypeHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(actionType));
      expect(await identity.acceptedActionTypes(actionTypeHash)).to.equal(true);
    }
    for (const contract of [identity, reputation, vault, riskManager, orchestrator]) {
      expect(await contract.owner()).to.equal(expectedOwner);
    }
  });

  it("does not queue or execute a pause when rerun after multisig cutover", async () => {
    const openDeployment = await deployments.get("OpenOrchestratorV2");
    const orchestrator = await ethers.getContractAt("OrchestratorV2", openDeployment.address);
    const multisigSigner = await ethers.getSigner(MULTI_SIG[network]);
    await orchestrator.connect(multisigSigner).unpauseOrchestrator();

    await deployOnchainRiskSystem(hre);
    expect(await orchestrator.paused()).to.equal(false);
  });
});
