import "module-alias/register";

import { expect } from "chai";
import hre, { deployments, ethers } from "hardhat";

import deployStakeRiskSystem from "../../deploy/26_deploy_stake_risk_system";
import {
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
  NON_CHARGEBACKABLE_FREE_TAKE_AMOUNT,
  NON_CHARGEBACKABLE_FREE_TAKE_COUNT,
  REVERSIBLE_PLATFORM_RESERVE_BPS,
  REVERSIBLE_PLATFORM_RISK_WINDOW,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_GRIEFING_CLIFF,
  RISK_GRIEFING_PENALTY_BPS_PER_HOUR,
  STAKE_VAULT_BASE_EXIT_DELAY,
} from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));

describe("Affine stake risk system deployment", () => {
  const network = deployments.getNetworkName();

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
    expect(deployedAddress("DeferredPayoutHook")).to.properAddress;
  });

  it("transfers every owned component to the configured multisig", async () => {
    const { deployer, orchestrator, vault, manager } = await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;
    expect(await orchestrator.owner()).to.eq(expectedOwner);
    expect(await vault.owner()).to.eq(expectedOwner);
    expect(await manager.owner()).to.eq(expectedOwner);
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
      expect(config.chargeback.reserveBps).to.eq(REVERSIBLE_PLATFORM_RESERVE_BPS);
      expect(config.chargeback.riskWindow).to.eq(REVERSIBLE_PLATFORM_RISK_WINDOW);
      expect(config.griefing.griefingCliff).to.eq(RISK_GRIEFING_CLIFF);
      expect(config.griefing.griefingPenaltyBpsPerHour).to.eq(RISK_GRIEFING_PENALTY_BPS_PER_HOUR);
      expect(config.griefing.freeTakeCount).to.eq(0);
    });
  }

  it("configures Zelle lifetime free takes only on the non-chargebackable platform", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(ZELLE);
    expect(config.enabled).to.eq(true);
    expect(config.chargeback.chargebackable).to.eq(false);
    expect(config.chargeback.reserveBps).to.eq(0);
    expect(config.griefing.freeTakeCount).to.eq(NON_CHARGEBACKABLE_FREE_TAKE_COUNT);
    expect(config.griefing.freeTakeAmount).to.eq(NON_CHARGEBACKABLE_FREE_TAKE_AMOUNT);
  });

  it("uses the deployed modular attestation verifier and RiskManager EIP-712 domain", async () => {
    const { deployer, manager } = await contracts();
    const verifier = await ethers.getContractAt(
      "MultiAttestationVerifier",
      deployedAddress("MultiAttestationVerifier"),
    );
    expect(await manager.attestationVerifier()).to.eq(verifier.address);
    expect((await verifier.requiredSignatures()).toNumber()).to.eq(MULTI_WITNESS_THRESHOLD[network]);
    expect((await verifier.witnesses()).map((w) => w.toLowerCase())).to.have.members(
      MULTI_WITNESS_ADDRESSES[network].map((w) => w.toLowerCase()),
    );

    const { chainId } = await ethers.provider.getNetwork();
    const chargeback = {
      chainId,
      riskManager: manager.address,
      orchestrator: await manager.orchestrator(),
      intentHash: ethers.utils.id("affine-risk-deployment-test"),
      paymentMethod: PAYPAL,
      chargebackAmount: 1,
      evidenceId: ethers.utils.id("deployment-evidence"),
      nonce: 1,
      validAfter: 1,
      validUntil: 2,
    };
    const domain = { name: "ZKP2P RiskManager", version: "1", chainId, verifyingContract: manager.address };
    const types = {
      ChargebackAttestation: [
        { name: "chainId", type: "uint256" },
        { name: "riskManager", type: "address" },
        { name: "orchestrator", type: "address" },
        { name: "intentHash", type: "bytes32" },
        { name: "paymentMethod", type: "bytes32" },
        { name: "chargebackAmount", type: "uint256" },
        { name: "evidenceId", type: "bytes32" },
        { name: "nonce", type: "uint256" },
        { name: "validAfter", type: "uint64" },
        { name: "validUntil", type: "uint64" },
      ],
    };
    const digest = await manager.hashChargebackAttestation(chargeback);
    const signature = await deployer._signTypedData(domain, types, chargeback);
    expect(await verifier.verify(digest, [signature], "0x")).to.eq(true);
  });

  it("reruns idempotently without changing initialized wiring", async () => {
    const before = await contracts();
    const controller = await before.vault.controller();
    const deferredHook = await before.manager.deferredPayoutHook();
    await deployStakeRiskSystem(hre);
    expect(await before.vault.controller()).to.eq(controller);
    expect(await before.manager.deferredPayoutHook()).to.eq(deferredHook);
  });
});
