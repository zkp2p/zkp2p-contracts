import "module-alias/register";

import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";

import deployStakeRiskSystem, {
  assertFreshNonLocalStakeRiskDeployment,
  chargebackWitnessConfigForNetwork,
  stakeRiskPlatformPolicyForNetwork,
} from "../../deploy/26_deploy_stake_risk_system";
import {
  MULTI_SIG,
  RISK_CALLBACK_GAS_LIMIT,
  STAKE_VAULT_BASE_EXIT_DELAY,
} from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Affine stake risk system deployment", () => {
  const network = deployments.getNetworkName();
  const platformPolicy = stakeRiskPlatformPolicyForNetwork(network);

  function deployedAddress(contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  async function contracts() {
    const [deployer] = await ethers.getSigners();
    return {
      deployer,
      orchestrator: await ethers.getContractAt("OrchestratorV3", deployedAddress("OrchestratorV3")),
      vault: await ethers.getContractAt("StakeVault", deployedAddress("StakeVault")),
      manager: await ethers.getContractAt("RiskManager", deployedAddress("RiskManager")),
      chargebackVerifier: await ethers.getContractAt(
        "MultiAttestationVerifier",
        deployedAddress("ChargebackAttestationVerifier"),
      ),
      deferredHook: await ethers.getContractAt("DeferredPayoutHook", deployedAddress("DeferredPayoutHook")),
      orchestratorRegistry: await ethers.getContractAt(
        "OrchestratorRegistry",
        deployedAddress("OrchestratorRegistry"),
      ),
    };
  }

  it("deploys the linked orchestrator components", async () => {
    expect(deployedAddress("BoundedCall")).to.properAddress;
    expect(deployedAddress("PostIntentHookExecutor")).to.properAddress;
    expect(deployedAddress("OrchestratorV3")).to.properAddress;
  });

  it("deploys the replacement risk components", async () => {
    expect(deployedAddress("StakeVault")).to.properAddress;
    expect(deployedAddress("RiskManager")).to.properAddress;
    expect(deployedAddress("ChargebackAttestationVerifier")).to.properAddress;
    expect(deployedAddress("DeferredPayoutHook")).to.properAddress;
  });

  it("transfers every owned component to the configured multisig", async () => {
    const { deployer, orchestrator, vault, manager, chargebackVerifier } = await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    expect(await orchestrator.owner()).to.eq(expectedOwner);
    expect(await vault.owner()).to.eq(expectedOwner);
    expect(await manager.owner()).to.eq(expectedOwner);
    expect(await chargebackVerifier.owner()).to.eq(expectedOwner);
  });

  it("wires RiskManager as the vault controller", async () => {
    const { vault, manager } = await contracts();
    expect(await vault.controller()).to.eq(manager.address);
  });

  it("wires the immutable orchestrator and vault into RiskManager", async () => {
    const { orchestrator, vault, manager } = await contracts();
    expect(await manager.orchestrator()).to.eq(orchestrator.address);
    expect(await manager.stakeVault()).to.eq(vault.address);
  });

  it("wires the canonical deferred payout hook in both directions", async () => {
    const { vault, manager, deferredHook } = await contracts();
    expect(await manager.deferredPayoutHook()).to.eq(deferredHook.address);
    expect(await deferredHook.stakeVault()).to.eq(vault.address);
    expect(await deferredHook.riskManager()).to.eq(manager.address);
  });

  it("registers OrchestratorV3 for escrow and deferred-hook authorization", async () => {
    const { orchestrator, orchestratorRegistry } = await contracts();
    expect(await orchestratorRegistry.isOrchestrator(orchestrator.address)).to.eq(true);
  });

  it("enables multiple intents without a stake-derived concurrency policy", async () => {
    const { orchestrator } = await contracts();
    expect(await orchestrator.allowMultipleIntents()).to.eq(true);
  });

  it("sets the bounded risk callback gas allowance", async () => {
    const { orchestrator } = await contracts();
    expect(await orchestrator.riskCallbackGasLimit()).to.eq(RISK_CALLBACK_GAS_LIMIT);
  });

  it("sets the configured base full-exit delay", async () => {
    const { vault } = await contracts();
    expect(await vault.baseExitDelay()).to.eq(STAKE_VAULT_BASE_EXIT_DELAY);
  });

  for (const [label, paymentMethod] of [["PayPal", PAYPAL], ["Venmo", VENMO]] as const) {
    it(`configures ${label} chargeback and griefing curves`, async () => {
      const { manager } = await contracts();
      const config = await manager.getPlatformRiskConfig(paymentMethod);
      expect(config.enabled).to.eq(true);
      expect(config.chargeback.chargebackable).to.eq(true);
      expect(config.chargeback.deferredPayoutEnabled).to.eq(true);
      expect(config.chargeback.reserveBps).to.eq(platformPolicy.reversible.chargeback.reserveBps);
      expect(config.chargeback.riskWindow).to.eq(platformPolicy.reversible.chargeback.riskWindow);
      expect(config.griefing.griefingCliff).to.eq(platformPolicy.reversible.griefing.griefingCliff);
      expect(config.griefing.griefingPenaltyBpsPerHour)
        .to.eq(platformPolicy.reversible.griefing.griefingPenaltyBpsPerHour);
      expect(config.griefing.freeTakeCount).to.eq(0);
    });
  }

  it("configures Zelle lifetime free takes only on the non-chargebackable platform", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(ZELLE);
    expect(config.enabled).to.eq(true);
    expect(config.chargeback.chargebackable).to.eq(false);
    expect(config.chargeback.reserveBps).to.eq(0);
    expect(config.griefing.freeTakeCount).to.eq(platformPolicy.nonChargebackable.griefing.freeTakeCount);
    expect(config.griefing.freeTakeAmount).to.eq(platformPolicy.nonChargebackable.griefing.freeTakeAmount);
  });

  it("refuses nonlocal deployment without governance-ratified platform policy", async () => {
    expect(() => stakeRiskPlatformPolicyForNetwork("base")).to.throw(
      "No governance-ratified stake risk platform policy for network: base",
    );
  });

  it("requires chargeback witnesses to be disjoint from payment witnesses", () => {
    const witnesses = [
      "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
      "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    ];
    expect(() => chargebackWitnessConfigForNetwork("base_staging", witnesses.join(","), [witnesses[0]]))
      .to.throw("chargeback witnesses must be disjoint from payment witnesses");
  });

  it("fails before a nonlocal canonical deployment can be overwritten", async () => {
    const lookedUp: string[] = [];
    await expect(assertFreshNonLocalStakeRiskDeployment("base_staging", async (name) => {
      lookedUp.push(name);
      return name === "OrchestratorV3" ? { address: ethers.constants.AddressZero } : null;
    })).to.be.rejectedWith("use a separately named, governance-reviewed migration");
    expect(lookedUp).to.include("OrchestratorV3");
  });

  it("uses the deployed modular attestation verifier and RiskManager EIP-712 domain", async () => {
    const { manager } = await contracts();
    const verifier = await ethers.getContractAt(
      "MultiAttestationVerifier",
      deployedAddress("ChargebackAttestationVerifier"),
    );
    const witnessConfig = chargebackWitnessConfigForNetwork(network);
    expect(await manager.attestationVerifier()).to.eq(verifier.address);
    expect(verifier.address).not.to.eq(deployedAddress("MultiAttestationVerifier"));
    expect((await verifier.requiredSignatures()).toNumber()).to.eq(witnessConfig.threshold);
    expect((await verifier.witnesses()).map((w) => w.toLowerCase())).to.have.members(
      witnessConfig.witnesses.map((w) => w.toLowerCase()),
    );

    const { chainId } = await ethers.provider.getNetwork();
    const chargeback = {
      intentHash: ethers.utils.id("affine-risk-deployment-test"),
      dataHash: ethers.utils.id("deployment-evidence"),
      signatures: [],
      data: "0x",
      metadata: "0x",
    };
    const domain = { name: "ZKP2P RiskManager", version: "1", chainId, verifyingContract: manager.address };
    const types = {
      ChargebackAttestation: [
        { name: "intentHash", type: "bytes32" },
        { name: "dataHash", type: "bytes32" },
      ],
    };
    const digest = await manager.hashChargebackAttestation(chargeback);
    expect(digest).to.eq(ethers.utils._TypedDataEncoder.hash(domain, types, chargeback));

    if (network === "localhost" || network === "hardhat") {
      const signers = await ethers.getSigners();
      const localWitnesses = signers.filter((signer) => witnessConfig.witnesses
        .map((address) => address.toLowerCase()).includes(signer.address.toLowerCase()));
      const value = { intentHash: chargeback.intentHash, dataHash: chargeback.dataHash };
      const signatures = [
        await localWitnesses[0]._signTypedData(domain, types, value),
        await localWitnesses[1]._signTypedData(domain, types, value),
      ];
      expect(await verifier.verify(digest, signatures, "0x")).to.eq(true);
    }
  });

  it("reruns idempotently without changing initialized wiring", async function () {
    this.timeout(180_000);
    const before = await contracts();
    const controller = await before.vault.controller();
    const deferredHook = await before.manager.deferredPayoutHook();
    await deployStakeRiskSystem(hre);
    expect(await before.vault.controller()).to.eq(controller);
    expect(await before.manager.deferredPayoutHook()).to.eq(deferredHook);
  });
});
