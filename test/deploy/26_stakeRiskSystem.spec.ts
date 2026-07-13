import "module-alias/register";

import { expect } from "chai";
import { deployments, ethers } from "hardhat";

import {
  MULTI_SIG,
  REVERSIBLE_PLATFORM_RESERVE_BPS,
  REVERSIBLE_PLATFORM_RISK_WINDOW,
  RISK_CALLBACK_GAS_LIMIT,
  RISK_MAX_INTENT_LIFETIME,
  STAKE_RISK_CONCURRENCY_LIMITS,
  STAKE_RISK_TIER_THRESHOLDS,
  STAKE_VAULT_BASE_EXIT_DELAY,
} from "../../deployments/parameters";

const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));

describe("Stake risk system deployment", () => {
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
      manager: await ethers.getContractAt("RiskTierManager", deployedAddress("RiskTierManager")),
      deferredHook: await ethers.getContractAt("DeferredPayoutHook", deployedAddress("DeferredPayoutHook")),
      orchestratorRegistry: await ethers.getContractAt(
        "OrchestratorRegistry",
        deployedAddress("OrchestratorRegistry"),
      ),
    };
  }

  it("deploys all four stake risk components", async () => {
    expect(deployedAddress("OrchestratorV3")).to.properAddress;
    expect(deployedAddress("StakeVault")).to.properAddress;
    expect(deployedAddress("RiskTierManager")).to.properAddress;
    expect(deployedAddress("DeferredPayoutHook")).to.properAddress;
  });

  it("transfers owned components to the configured multisig", async () => {
    const { deployer, orchestrator, vault, manager } = await contracts();
    const expectedOwner = MULTI_SIG[network] || deployer.address;

    expect(await orchestrator.owner()).to.eq(expectedOwner);
    expect(await vault.owner()).to.eq(expectedOwner);
    expect(await manager.owner()).to.eq(expectedOwner);
  });

  it("wires RiskTierManager as the vault controller", async () => {
    const { vault, manager } = await contracts();
    expect(await vault.controller()).to.eq(manager.address);
  });

  it("wires the canonical orchestrator and vault into RiskTierManager", async () => {
    const { orchestrator, vault, manager } = await contracts();
    expect(await manager.orchestrator()).to.eq(orchestrator.address);
    expect(await manager.stakeVault()).to.eq(vault.address);
  });

  it("wires the canonical deferred payout hook into RiskTierManager", async () => {
    const { manager, deferredHook } = await contracts();
    expect(await manager.deferredPayoutHook()).to.eq(deferredHook.address);
  });

  it("wires the vault and manager into DeferredPayoutHook", async () => {
    const { vault, manager, deferredHook } = await contracts();
    expect(await deferredHook.stakeVault()).to.eq(vault.address);
    expect(await deferredHook.riskTierManager()).to.eq(manager.address);
  });

  it("registers OrchestratorV3 for escrow and deferred-hook authorization", async () => {
    const { orchestrator, orchestratorRegistry } = await contracts();
    expect(await orchestratorRegistry.isOrchestrator(orchestrator.address)).to.eq(true);
  });

  it("enables multiple intents for tier-based concurrency enforcement", async () => {
    const { orchestrator } = await contracts();
    expect(await orchestrator.allowMultipleIntents()).to.eq(true);
  });

  it("sets the bounded risk callback gas allowance", async () => {
    const { orchestrator } = await contracts();
    expect(await orchestrator.riskCallbackGasLimit()).to.eq(RISK_CALLBACK_GAS_LIMIT);
  });

  it("covers the escrow maximum intent lifetime in fallback risk timing", async () => {
    const { manager } = await contracts();
    expect(await manager.maxIntentLifetime()).to.eq(RISK_MAX_INTENT_LIFETIME);
  });

  it("sets the configured base full-exit delay", async () => {
    const { vault } = await contracts();
    expect(await vault.baseExitDelay()).to.eq(STAKE_VAULT_BASE_EXIT_DELAY);
  });

  it("sets all four positive stake thresholds", async () => {
    const { manager } = await contracts();
    const actual = await Promise.all([0, 1, 2, 3].map((index) => manager.tierThresholds(index)));
    expect(actual).to.deep.eq(STAKE_RISK_TIER_THRESHOLDS[network]);
  });

  it("sets all five tier concurrency limits", async () => {
    const { manager } = await contracts();
    const actual = await Promise.all([0, 1, 2, 3, 4].map((index) => manager.concurrencyLimits(index)));
    expect(actual.map((value) => value.toNumber())).to.deep.eq(STAKE_RISK_CONCURRENCY_LIMITS[network]);
  });

  it("configures the launch PayPal tier caps", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(PAYPAL);

    expect(config.enabled).to.eq(true);
    expect(config.chargebackable).to.eq(true);
    expect(config.deferredPayoutEnabled).to.eq(true);
    expect(config.reserveBps).to.eq(REVERSIBLE_PLATFORM_RESERVE_BPS);
    expect(config.riskWindow).to.eq(REVERSIBLE_PLATFORM_RISK_WINDOW);
    expect(config.tierCaps).to.deep.eq([0, 0, 750e6, 1_875e6, 3_750e6]);
  });

  it("configures the launch Venmo tier caps", async () => {
    const { manager } = await contracts();
    const config = await manager.getPlatformRiskConfig(VENMO);

    expect(config.tierCaps).to.deep.eq([0, 0, 1_000e6, 2_500e6, 5_000e6]);
  });

  it("uses the deployed modular attestation verifier for chargebacks", async () => {
    const { manager } = await contracts();
    expect(await manager.attestationVerifier()).to.eq(deployedAddress("SimpleAttestationVerifier"));
  });
});
