import { expect } from "chai";
import { BigNumber, Contract, ContractReceipt } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const precise = (amount: string | number) => ethers.utils.parseEther(String(amount));
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BASE_INTENT_PERIOD = HOUR;
const EXTENSION_SLOPE = 10;
const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));
const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const PAYEE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("maker-payee"));
const ZERO = ethers.constants.AddressZero;

describe("RiskManager and OrchestratorV3", () => {
  async function deployFixture() {
    const [owner, maker, makerDelegate, taker, secondTaker, recipient, other] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();

    const token = await (await ethers.getContractFactory("USDCMock"))
      .deploy(usdc(1_000_000), "USD Coin", "USDC");
    const paymentVerifierRegistry = await (await ethers.getContractFactory("PaymentVerifierRegistry")).deploy();
    const escrowRegistry = await (await ethers.getContractFactory("EscrowRegistry")).deploy();
    const relayerRegistry = await (await ethers.getContractFactory("RelayerRegistry")).deploy();
    const orchestratorRegistry = await (await ethers.getContractFactory("OrchestratorRegistry")).deploy();
    const legacyNullifierRegistry = await (await ethers.getContractFactory("NullifierRegistry")).deploy();
    const nullifierRegistry = await (await ethers.getContractFactory("NullifierRegistryV2"))
      .deploy(legacyNullifierRegistry.address);
    const verifier = await (await ethers.getContractFactory("PaymentVerifierMock")).deploy();
    const attestationVerifier = await (await ethers.getContractFactory("AttestationVerifierMock")).deploy();

    await paymentVerifierRegistry.addPaymentMethod(PAYPAL, verifier.address, [USD]);
    await paymentVerifierRegistry.addPaymentMethod(ZELLE, verifier.address, [USD]);

    const escrow = await (await ethers.getContractFactory("EscrowV2")).deploy(
      owner.address,
      network.chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      0,
      100,
      BASE_INTENT_PERIOD,
    );
    const boundedCall = await (await ethers.getContractFactory("BoundedCall")).deploy();
    const postIntentHookExecutor = await (await ethers.getContractFactory("PostIntentHookExecutor")).deploy();
    const riskSettlementExecutor = await (await ethers.getContractFactory("RiskSettlementExecutor", {
      libraries: { BoundedCall: boundedCall.address },
    })).deploy();
    const feeSettlementLib = await (await ethers.getContractFactory("FeeSettlementLib", {
      libraries: {
        PostIntentHookExecutor: postIntentHookExecutor.address,
        RiskSettlementExecutor: riskSettlementExecutor.address,
      },
    })).deploy();
    const orchestrator = await (await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        FeeSettlementLib: feeSettlementLib.address,
      },
    })).deploy(
      owner.address,
      network.chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      0,
      owner.address,
      2_000_000,
    );
    const vault = await (await ethers.getContractFactory("StakeVault")).deploy(
      owner.address,
      token.address,
      owner.address,
      30 * DAY,
      DAY,
    );
    const manager = await (await ethers.getContractFactory("RiskManager")).deploy(
      owner.address,
      orchestrator.address,
      vault.address,
      attestationVerifier.address,
      nullifierRegistry.address,
    );
    await nullifierRegistry.addWritePermission(owner.address);
    await vault.proposeController(manager.address);
    await time.increase(DAY);
    await manager.acceptVaultController();

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await orchestrator.setAllowMultipleIntents(true);
    await verifier.setShouldVerifyPayment(true);
    await verifier.setVerificationContext(orchestrator.address, escrow.address);

    await manager.setPlatformRiskConfig(ZELLE, {
      enabled: true,
      chargeback: {
        chargebackable: false,
        deferredPayoutEnabled: false,
        reserveBps: 0,
        riskWindow: 0,
      },
      intentExtension: {
        extensionPenaltyBpsPerHour: EXTENSION_SLOPE,
      },
    });
    await manager.setPlatformRiskConfig(PAYPAL, {
      enabled: true,
      chargeback: {
        chargebackable: true,
        deferredPayoutEnabled: false,
        reserveBps: 10_000,
        riskWindow: 30 * DAY,
      },
      intentExtension: {
        extensionPenaltyBpsPerHour: EXTENSION_SLOPE,
      },
    });

    await token.transfer(maker.address, usdc(100_000));
    await token.transfer(taker.address, usdc(20_000));
    await token.transfer(secondTaker.address, usdc(20_000));
    await token.connect(maker).approve(escrow.address, ethers.constants.MaxUint256);
    await token.connect(taker).approve(vault.address, ethers.constants.MaxUint256);
    await token.connect(secondTaker).approve(vault.address, ethers.constants.MaxUint256);

    await escrow.connect(maker).createDeposit({
      token: token.address,
      amount: usdc(50_000),
      intentAmountRange: { min: usdc(1), max: usdc(10_000) },
      paymentMethods: [PAYPAL, ZELLE],
      paymentMethodData: [
        { intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" },
        { intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" },
      ],
      currencies: [
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: {
          adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
        } }],
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: {
          adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
        } }],
      ],
      delegate: makerDelegate.address,
      intentGuardian: manager.address,
      retainOnEmpty: true,
    });
    await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, manager.address);

    return {
      owner,
      maker,
      makerDelegate,
      taker,
      secondTaker,
      recipient,
      other,
      network,
      token,
      escrow,
      orchestrator,
      vault,
      manager,
      paymentVerifierRegistry,
      nullifierRegistry,
      riskSettlementExecutor,
      orchestratorRegistry,
    };
  }

  function signalParams(
    escrow: Contract,
    recipient: string,
    amount: BigNumber,
    paymentMethod: string,
    postIntentHook = ZERO,
    referralFees: Array<{ recipient: string; fee: BigNumber }> = [],
  ) {
    return {
      escrow: escrow.address,
      depositId: 0,
      amount,
      to: recipient,
      paymentMethod,
      fiatCurrency: USD,
      conversionRate: precise(1),
      referralFees,
      gatingServiceSignature: "0x",
      signatureExpiration: 0,
      postIntentHook,
      preIntentHookData: "0x",
      data: "0x",
    };
  }

  function intentHashFrom(receipt: ContractReceipt): string {
    const event = receipt.events?.find((candidate) => candidate.event === "IntentSignaled");
    if (!event?.args?.intentHash) throw new Error("IntentSignaled event missing");
    return event.args.intentHash;
  }

  async function signalIntent(
    orchestrator: Contract,
    escrow: Contract,
    taker: any,
    amount: BigNumber,
    paymentMethod: string,
    postIntentHook = ZERO,
    recipient = taker.address,
  ): Promise<string> {
    const tx = await orchestrator.connect(taker).signalIntent(
      signalParams(escrow, recipient, amount, paymentMethod, postIntentHook),
    );
    return intentHashFrom(await tx.wait());
  }

  async function fulfillIntent(orchestrator: Contract, intentHash: string, releaseAmount: BigNumber) {
    const proof = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [releaseAmount, await time.latest(), PAYEE, USD, intentHash],
    );
    return orchestrator.fulfillIntent({
      paymentProof: proof,
      intentHash,
      verificationData: "0x",
      postIntentHookData: "0x",
    });
  }

  async function configureManagerFee(
    maker: any,
    feeRecipient: string,
    escrow: Contract,
    fee = precise("0.01"),
  ) {
    const rateManager = await (await ethers.getContractFactory("RateManagerMock")).deploy();
    const rateManagerId = ethers.utils.id("risk-settlement-manager");
    await rateManager.setManager(rateManagerId, true);
    await rateManager.setFee(rateManagerId, feeRecipient, fee);
    await rateManager.setRate(rateManagerId, escrow.address, 0, PAYPAL, USD, precise(1));
    await escrow.connect(maker).setRateManager(0, rateManager.address, rateManagerId);
    return rateManager;
  }

  async function chargebackAttestation(
    manager: Contract,
    intentHash: string,
    paymentAmount: BigNumber,
    disputeId = ethers.utils.id(`dispute-${intentHash}`),
    detailsOverrides: Record<string, unknown> = {},
    bindPayment = true,
  ) {
    const details = {
      paymentMethod: PAYPAL,
      originalPaymentId: ethers.utils.keccak256(
        ethers.utils.solidityPack(["string", "bytes32"], ["payment", intentHash]),
      ),
      disputeId,
      paymentAmount,
      paymentCurrency: USD,
      ...detailsOverrides,
    };
    const nullifierRegistry = await ethers.getContractAt("NullifierRegistryV2", await manager.nullifierRegistry());
    const canonicalPaymentId = ethers.utils.keccak256(
      ethers.utils.solidityPack(["string", "bytes32"], ["payment", intentHash]),
    );
    const canonicalNullifier = ethers.utils.keccak256(
      ethers.utils.solidityPack(["bytes32", "bytes32"], [PAYPAL, canonicalPaymentId]),
    );
    if (bindPayment && (await nullifierRegistry.intentHashByNullifier(canonicalNullifier)) === ethers.constants.HashZero) {
      await nullifierRegistry.addNullifier(canonicalNullifier, intentHash);
    }
    const data = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 paymentMethod,bytes32 originalPaymentId,bytes32 disputeId,uint256 paymentAmount,bytes32 paymentCurrency)"],
      [details],
    );
    return {
      intentHash,
      dataHash: ethers.utils.keccak256(data),
      signatures: [],
      data,
      metadata: "0x",
    };
  }

  describe("configuration and exact formulas", () => {
    it("binds settlement custody to the vault token", async () => {
      const { vault, manager, token } = await loadFixture(deployFixture);
      expect(await vault.stakeToken()).to.eq(token.address);
      expect(await manager.stakeVault()).to.eq(vault.address);
    });

    it("rejects a chargeback reserve above 100 percent", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_001, riskWindow: DAY },
        intentExtension: { extensionPenaltyBpsPerHour: 1 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("accepts risk-manager-owned deferred payout for a chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 10_000, riskWindow: DAY },
        intentExtension: { extensionPenaltyBpsPerHour: 1 },
      });
      expect((await manager.getPlatformRiskConfig(PAYPAL)).chargeback.deferredPayoutEnabled).to.eq(true);
    });

    it("rejects a zero extension slope on an enabled platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(ZELLE, {
        enabled: true,
        chargeback: { chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0 },
        intentExtension: { extensionPenaltyBpsPerHour: 0 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("calculates cumulative paid-extension collateral", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateIntentExtensionCost(usdc(1_000), 23 * HOUR, EXTENSION_SLOPE))
        .to.eq(usdc(23));
    });

    it("prices extension collateral on the full locked amount", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateIntentExtensionCost(usdc(500), HOUR, EXTENSION_SLOPE))
        .to.eq(usdc("0.5"));
    });

    it("caps terminal charges to purchased time", async () => {
      const { manager } = await loadFixture(deployFixture);
      const result = await manager.calculateIntentExtensionPenalty(
        usdc(1_000),
        10_000,
        10_000 + 3 * HOUR,
        2 * HOUR,
        EXTENSION_SLOPE,
      );
      expect(result.penalty).to.eq(usdc(2));
      expect(result.chargeableTime).to.eq(2 * HOUR);
    });

    it("rounds a chargeback reserve upward", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateChargebackReserve(101, 5_000)).to.eq(51);
    });

    it("reserves chargeback coverage only at admission", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateChargebackReserve(usdc(1_000), 10_000)).to.eq(usdc(1_000));
    });

    it("rejects a curve that could charge more than the intent amount", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(ZELLE, {
        enabled: true,
        chargeback: { chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0 },
        intentExtension: { extensionPenaltyBpsPerHour: 84 },
      })).to.be.revertedWithCustomError(manager, "ExtensionPenaltyExceedsIntentAmount");
    });
  });

  describe("free initial expiry", () => {
    it("admits a non-chargebackable intent without stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(1);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("admits another intent after cancellation without a usage counter", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const firstIntentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await orchestrator.connect(taker).cancelIntent(firstIntentHash);
      const secondIntentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      expect((await manager.getRiskPosition(secondIntentHash)).mode).to.eq(1);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("cancels during the initial expiry period without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(BASE_INTENT_PERIOD - 1);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("expires after the one-hour base period without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(BASE_INTENT_PERIOD + 1);
      await escrow.pruneExpiredIntents(0);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("snapshots the full intent amount without extension collateral at admission", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(21), ZELLE);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(1);
      expect(position.intentAmount).to.eq(usdc(21));
      expect(position.extensionReservation).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("admits non-chargebackable intents concurrently across delegated takers", async () => {
      const { owner: safe, taker, secondTaker, escrow, orchestrator, vault, manager } =
        await loadFixture(deployFixture);
      await vault.connect(safe).setTakerAuthorization(taker.address, true);
      await vault.connect(safe).setTakerAuthorization(secondTaker.address, true);
      const first = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      const second = await signalIntent(orchestrator, escrow, secondTaker, usdc(20), ZELLE);
      expect((await manager.getRiskPosition(first)).mode).to.eq(1);
      expect((await manager.getRiskPosition(second)).mode).to.eq(1);
      expect(await vault.reservedStake(safe.address)).to.eq(0);
    });
  });

  describe("admission and portfolio reservations", () => {
    it("uses a delegated Safe as the shared stake owner", async () => {
      const { owner: safe, taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await token.connect(safe).approve(vault.address, ethers.constants.MaxUint256);
      await vault.connect(safe).depositStakeFor(taker.address, usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.stakeOwner).to.eq(safe.address);
      expect(await vault.reservedStake(safe.address)).to.eq(usdc(500));
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
    });

    it("admits multiple intents based only on shared free stake", async () => {
      const { taker, escrow, orchestrator, vault } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_500));
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(1_500));
    });

    it("rejects only when the shared portfolio reservation exceeds free stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(999));
      await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await expect(signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("snapshots platform policy before governance changes", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: DAY },
        intentExtension: {
          extensionPenaltyBpsPerHour: EXTENSION_SLOPE,
        },
      });
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: 30 * DAY },
        intentExtension: {
          extensionPenaltyBpsPerHour: 20,
        },
      });
      const position = await manager.getRiskPosition(intentHash);
      expect(position.chargebackReserveBps).to.eq(10_000);
      expect(position.riskWindow).to.eq(DAY);
      expect(position.extensionPenaltyBpsPerHour).to.eq(EXTENSION_SLOPE);
    });
  });

  describe("stake-funded intent extensions", () => {
    it("uses existing taker stake and charges elapsed extension time on cancellation", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const baseExpiry = (await manager.getRiskPosition(intentHash)).baseIntentExpiry.toNumber();

      await expect(manager.connect(taker).extendIntent(intentHash, 2 * HOUR))
        .to.emit(manager, "IntentExtended");
      expect((await manager.getRiskPosition(intentHash)).extensionReservation).to.eq(usdc(2));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(2));

      await time.setNextBlockTimestamp(baseExpiry + HOUR);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.extensionPenalty).to.eq(usdc(1));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(1));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(9));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("charges the same elapsed curve on fulfillment", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const baseExpiry = (await manager.getRiskPosition(intentHash)).baseIntentExpiry.toNumber();
      await manager.connect(taker).extendIntent(intentHash, 2 * HOUR);

      await time.setNextBlockTimestamp(baseExpiry + HOUR);
      await fulfillIntent(orchestrator, intentHash, usdc(1_000));
      expect((await manager.getRiskPosition(intentHash)).extensionPenalty).to.eq(usdc(1));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(1));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(9));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("keeps extension collateral isolated from chargeback coverage", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(2_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const positionAtAdmission = await manager.getRiskPosition(intentHash);
      const extensionId = await manager.extensionReservationId(intentHash);

      await manager.connect(taker).extendIntent(intentHash, 2 * HOUR);
      expect((await vault.getReservation(intentHash)).amount).to.eq(usdc(1_000));
      expect((await vault.getReservation(extensionId)).amount).to.eq(usdc(2));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(1_002));

      await time.setNextBlockTimestamp(positionAtAdmission.baseIntentExpiry.toNumber() + HOUR);
      await fulfillIntent(orchestrator, intentHash, usdc(600));

      const settled = await manager.getRiskPosition(intentHash);
      expect(settled.extensionPenalty).to.eq(usdc(1));
      expect(settled.reservedAmount).to.eq(usdc(600));
      expect((await vault.getReservation(intentHash)).amount).to.eq(usdc(600));
      expect((await vault.getReservation(extensionId)).active).to.eq(false);
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(600));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(1));
    });

    it("lets anyone sponsor only with newly supplied taker-owned stake", async () => {
      const { taker, secondTaker: sponsor, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(5));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const sponsorBefore = await token.balanceOf(sponsor.address);

      await expect(manager.connect(sponsor).stakeAndExtendIntent(intentHash, 2 * HOUR))
        .to.emit(vault, "StakeSponsoredAndReserved");
      expect(await token.balanceOf(sponsor.address)).to.eq(sponsorBefore.sub(usdc(2)));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(7));
      expect(await vault.freeStake(taker.address)).to.eq(usdc(5));

      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(7));
      expect(await vault.freeStake(taker.address)).to.eq(usdc(7));
    });

    it("atomically rolls back sponsorship when the sponsor has not approved StakeVault", async () => {
      const { taker, secondTaker: sponsor, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await token.connect(sponsor).approve(vault.address, 0);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const expiryBefore = (await escrow.getDepositIntent(0, intentHash)).expiryTime;

      await expect(manager.connect(sponsor).stakeAndExtendIntent(intentHash, 2 * HOUR)).to.be.reverted;

      const position = await manager.getRiskPosition(intentHash);
      expect(position.totalExtensionTime).to.eq(0);
      expect(position.extensionReservation).to.eq(0);
      expect((await escrow.getDepositIntent(0, intentHash)).expiryTime).to.eq(expiryBefore);
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("does not let a third party lock the taker's existing stake", async () => {
      const { taker, secondTaker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await expect(manager.connect(secondTaker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(manager, "UnauthorizedStakeExtension");
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("cannot revive an already expired intent", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const baseExpiry = (await manager.getRiskPosition(intentHash)).baseIntentExpiry.toNumber();
      await time.increaseTo(baseExpiry);
      await expect(manager.connect(taker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(manager, "IntentAlreadyExpired");
    });

    it("enforces Escrow's five-day total lifetime ceiling before reserving stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(200));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      const maximumExtension = 5 * DAY - BASE_INTENT_PERIOD;

      await manager.connect(taker).extendIntent(intentHash, maximumExtension);
      const positionBefore = await manager.getRiskPosition(intentHash);
      const reservationBefore = positionBefore.extensionReservation;

      await expect(manager.connect(taker).extendIntent(intentHash, 1))
        .to.be.revertedWithCustomError(manager, "ExtensionExceedsIntentLifetime");
      const positionAfter = await manager.getRiskPosition(intentHash);
      expect(positionAfter.totalExtensionTime).to.eq(maximumExtension);
      expect(positionAfter.extensionReservation).to.eq(reservationBefore);
    });

    it("blocks existing-stake extension top-ups while reservations are paused", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await manager.connect(taker).extendIntent(intentHash, HOUR);
      await vault.setStakeOperationsPaused(false, true);

      await expect(manager.connect(taker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(vault, "StakeActionPaused");
    });

    it("blocks first-time existing-stake and sponsored extensions while reservations are paused", async () => {
      const { taker, secondTaker: sponsor, escrow, orchestrator, vault, manager } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await vault.setStakeOperationsPaused(false, true);

      await expect(manager.connect(taker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(vault, "StakeActionPaused");
      await expect(manager.connect(sponsor).stakeAndExtendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(vault, "StakeActionPaused");
      expect((await manager.getRiskPosition(intentHash)).totalExtensionTime).to.eq(0);
    });

    it("blocks existing-stake extension top-ups after the taker requests exit", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await manager.connect(taker).extendIntent(intentHash, HOUR);
      await vault.connect(taker).requestExit();

      await expect(manager.connect(taker).extendIntent(intentHash, HOUR))
        .to.be.revertedWithCustomError(vault, "AlreadyExiting");
    });

    it("uses cumulative rounding across repeated extensions", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(10);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1), ZELLE);
      await manager.connect(taker).extendIntent(intentHash, 1);
      await manager.connect(taker).extendIntent(intentHash, 1);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.totalExtensionTime).to.eq(2);
      expect(position.extensionReservation).to.eq(1);
      expect(await vault.reservedStake(taker.address)).to.eq(1);
    });

    it("rejects sponsored top-ups that add no reservation after cumulative rounding", async () => {
      const { taker, secondTaker: sponsor, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(10);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1), ZELLE);
      await manager.connect(taker).extendIntent(intentHash, 1);
      const sponsorBalance = await token.balanceOf(sponsor.address);

      await expect(manager.connect(sponsor).stakeAndExtendIntent(intentHash, 1))
        .to.be.revertedWithCustomError(manager, "ZeroAmount");
      expect(await token.balanceOf(sponsor.address)).to.eq(sponsorBalance);
      expect((await manager.getRiskPosition(intentHash)).totalExtensionTime).to.eq(1);
    });

    it("records the original cancellation time when a terminal callback fails", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const mock = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, mock.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(10), ZELLE);
      await mock.setRevertOnCallback(true);
      const before = await time.latest();
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const cancelledAt = await orchestrator.getIntentCancellation(intentHash);
      expect(cancelledAt).to.be.gte(before);
      expect(cancelledAt).to.eq(await time.latest());
    });
  });

  describe("settlement and chargeback coverage", () => {
    it("settles a non-chargebackable intent without an admission reservation", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await fulfillIntent(orchestrator, intentHash, usdc(1_000));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("resizes stake coverage from intent amount to exact released amount", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(600));
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(3);
      expect(position.reservedAmount).to.eq(usdc(600));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(600));
    });

    it("applies the same stake-backed settlement accounting to manual release", async () => {
      const { maker, taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const balanceBefore = await token.balanceOf(taker.address);
      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(3);
      expect(position.isManualRelease).to.eq(true);
      expect(position.coverageDeadline).to.be.gt(0);
      expect(position.reservedAmount).to.eq(usdc(500));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(500));
      expect(await token.balanceOf(taker.address)).to.eq(balanceBefore.add(usdc(500)));
    });

    it("charges the same elapsed extension penalty on manual release", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(510));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const baseExpiry = (await manager.getRiskPosition(intentHash)).baseIntentExpiry.toNumber();
      await manager.connect(taker).extendIntent(intentHash, 2 * HOUR);

      await time.setNextBlockTimestamp(baseExpiry + HOUR);
      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);

      const position = await manager.getRiskPosition(intentHash);
      expect(position.isManualRelease).to.eq(true);
      expect(position.extensionPenalty).to.eq(usdc("0.5"));
      expect(position.reservedAmount).to.eq(usdc(500));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc("0.5"));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(500));
    });

    it("authenticates the payment-style typed data and compensates the exact gross release", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const claim = await chargebackAttestation(manager, intentHash, usdc(500));
      const { chainId } = await ethers.provider.getNetwork();
      expect(await manager.hashChargebackAttestation(claim)).to.eq(ethers.utils._TypedDataEncoder.hash(
        { name: "ZKP2P RiskManager", version: "1", chainId, verifyingContract: manager.address },
        { ChargebackAttestation: [
          { name: "intentHash", type: "bytes32" },
          { name: "dataHash", type: "bytes32" },
        ] },
        { intentHash: claim.intentHash, dataHash: claim.dataHash },
      ));
      await manager.submitChargeback(claim);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(5);
    });

    it("rejects reused dispute evidence across positions", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const firstHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const secondHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, firstHash, usdc(500));
      await fulfillIntent(orchestrator, secondHash, usdc(500));
      const disputeId = ethers.utils.id("shared-dispute");
      await manager.submitChargeback(await chargebackAttestation(manager, firstHash, usdc(500), disputeId));
      await expect(manager.submitChargeback(
        await chargebackAttestation(manager, secondHash, usdc(500), disputeId),
      )).to.be.revertedWithCustomError(manager, "ChargebackEvidenceUsed");
    });

    it("accepts witness-bound chargebacks after manual release without a payment nullifier", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const manualHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await orchestrator.connect(maker).releaseFundsToPayer(manualHash);
      await manager.submitChargeback(
        await chargebackAttestation(manager, manualHash, usdc(500), undefined, {}, false),
      );
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(manualHash)).status).to.eq(5);
    });

    it("rejects unbound or mismatched payment identifiers after proof-based fulfillment", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const verifiedHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, verifiedHash, usdc(500));
      await expect(manager.submitChargeback(
        await chargebackAttestation(manager, verifiedHash, usdc(500), undefined, {}, false),
      )).to.be.revertedWithCustomError(manager, "InvalidPaymentBinding");
      await expect(manager.submitChargeback(await chargebackAttestation(
        manager,
        verifiedHash,
        usdc(500),
        undefined,
        { originalPaymentId: ethers.utils.id("wrong-payment") },
      ))).to.be.revertedWithCustomError(manager, "InvalidPaymentBinding");
    });

    it("releases remaining coverage at maturity", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await manager.releaseMaturedPosition(intentHash);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("rejects chargeback compensation at the exact coverage deadline", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      const claim = await chargebackAttestation(manager, intentHash, usdc(500));
      await expect(manager.submitChargeback(claim))
        .to.be.revertedWithCustomError(manager, "ChargebackWindowClosed");
    });
  });

  describe("post-funds risk settlement boundary", () => {
    async function enableDeferred(manager: Contract) {
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 10_000, riskWindow: DAY },
        intentExtension: {
          extensionPenaltyBpsPerHour: EXTENSION_SLOPE,
        },
      });
    }

    it("pulls deferred custody directly into StakeVault and clears the exact allowance", async () => {
      const { taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await enableDeferred(manager);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(100), PAYPAL);
      expect((await manager.getRiskPosition(intentHash)).mode).to.eq(3);

      const recipientBefore = await token.balanceOf(taker.address);
      await fulfillIntent(orchestrator, intentHash, usdc(100));

      const position = await manager.getRiskPosition(intentHash);
      const deferredStake = await vault.getDeferredStake(intentHash);
      expect(position.grossReleasedAmount).to.eq(usdc(100));
      expect(position.executableAmount).to.eq(usdc(100));
      expect(deferredStake.grossAmount).to.eq(usdc(100));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(100));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(100));
      expect(await vault.freeStake(taker.address)).to.eq(0);
      expect(await token.balanceOf(taker.address)).to.eq(recipientBefore);
      expect(await token.allowance(orchestrator.address, manager.address)).to.eq(0);
    });

    it("rejects a deferred third-party payout at admission before fiat payment", async () => {
      const { taker, recipient, escrow, orchestrator, manager } = await loadFixture(deployFixture);
      await enableDeferred(manager);
      await expect(signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(100),
        PAYPAL,
        ZERO,
        recipient.address,
      )).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("defers gross custody and the exact protocol, referral, and manager fee plan", async () => {
      const { owner, maker, taker, recipient, other, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await enableDeferred(manager);
      await orchestrator.setProtocolFee(precise("0.01"));
      await configureManagerFee(maker, recipient.address, escrow);
      const grossAmount = usdc(1).add(1);
      const referralFee = precise("0.01");
      const tx = await orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        grossAmount,
        PAYPAL,
        ZERO,
        [{ recipient: other.address, fee: referralFee }],
      ));
      const intentHash = intentHashFrom(await tx.wait());
      const protocolBefore = await token.balanceOf(owner.address);
      const referrerBefore = await token.balanceOf(other.address);
      const managerBefore = await token.balanceOf(recipient.address);

      await fulfillIntent(orchestrator, intentHash, grossAmount);

      const feeEach = grossAmount.mul(precise("0.01")).div(precise(1));
      const executableAmount = grossAmount.sub(feeEach.mul(3));
      const position = await manager.getRiskPosition(intentHash);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore);
      expect(await token.balanceOf(other.address)).to.eq(referrerBefore);
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore);
      expect(position.grossReleasedAmount).to.eq(grossAmount);
      expect(position.executableAmount).to.eq(executableAmount);
      expect(Object.prototype.hasOwnProperty.call(position, "coveredAmount")).to.eq(false);
      expect(Object.prototype.hasOwnProperty.call(position, "deferredStakeAmount")).to.eq(false);
      expect(Object.prototype.hasOwnProperty.call(position, "deferredFeeAmount")).to.eq(false);
      expect(position.grossReleasedAmount.sub(position.executableAmount)).to.eq(feeEach.mul(3));
      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(grossAmount);
      const allocations = await vault.getDeferredFeeAllocations(intentHash);
      expect(allocations.map((allocation: any) => allocation.amount)).to.deep.eq([feeEach, feeEach, feeEach]);
      expect(await vault.stakeBalance(taker.address)).to.eq(grossAmount);
      expect(await vault.reservedStake(taker.address)).to.eq(grossAmount);

      const deadline = position.coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await manager.releaseMaturedPosition(intentHash);

      expect(await vault.stakeBalance(taker.address)).to.eq(executableAmount);
      expect(await vault.freeStake(taker.address)).to.eq(executableAmount);
      expect(await vault.claimableFees(owner.address)).to.eq(feeEach);
      expect(await vault.claimableFees(other.address)).to.eq(feeEach);
      expect(await vault.claimableFees(recipient.address)).to.eq(feeEach);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore);
      expect(await token.balanceOf(other.address)).to.eq(referrerBefore);
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore);

      await vault.withdrawFeeClaimFor(owner.address);
      await vault.withdrawFeeClaimFor(other.address);
      await vault.withdrawFeeClaimFor(recipient.address);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore.add(feeEach));
      expect(await token.balanceOf(other.address)).to.eq(referrerBefore.add(feeEach));
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore.add(feeEach));
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());
    });

    it("slashes gross deferred stake to the LP and cancels all contingent fees", async () => {
      const { owner, maker, taker, recipient, other, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await enableDeferred(manager);
      await orchestrator.setProtocolFee(precise("0.01"));
      await configureManagerFee(maker, recipient.address, escrow);

      const grossAmount = usdc(100);
      const fee = precise("0.01");
      const signalTx = await orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        grossAmount,
        PAYPAL,
        ZERO,
        [{ recipient: other.address, fee }],
      ));
      const intentHash = intentHashFrom(await signalTx.wait());
      const protocolBefore = await token.balanceOf(owner.address);
      const referralBefore = await token.balanceOf(other.address);
      const managerBefore = await token.balanceOf(recipient.address);
      await fulfillIntent(orchestrator, intentHash, grossAmount);

      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore);
      expect(await token.balanceOf(other.address)).to.eq(referralBefore);
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore);
      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(grossAmount);
      expect(await vault.stakeBalance(taker.address)).to.eq(grossAmount);
      expect(await vault.freeStake(taker.address)).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(grossAmount);
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());

      await manager.submitChargeback(await chargebackAttestation(manager, intentHash, grossAmount));

      expect((await vault.getDeferredStake(intentHash)).staker).to.eq(ZERO);
      expect(await vault.claimableCompensation(maker.address)).to.eq(grossAmount);
      expect(await vault.claimableFees(owner.address)).to.eq(0);
      expect(await vault.claimableFees(other.address)).to.eq(0);
      expect(await vault.claimableFees(recipient.address)).to.eq(0);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore);
      expect(await token.balanceOf(other.address)).to.eq(referralBefore);
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore);
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());

      const makerBefore = await token.balanceOf(maker.address);
      await vault.connect(maker).withdrawCompensation(maker.address);
      expect(await token.balanceOf(maker.address)).to.eq(makerBefore.add(grossAmount));
      expect(await vault.claimableCompensation(maker.address)).to.eq(0);
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
      expect(await vault.freeStake(taker.address)).to.eq(0);
    });

    it("releases matured deferred custody as reusable taker stake", async () => {
      const { taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await enableDeferred(manager);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(100), PAYPAL);
      const stakeBefore = await vault.stakeBalance(taker.address);
      const beneficiaryBefore = await token.balanceOf(taker.address);

      await fulfillIntent(orchestrator, intentHash, usdc(100));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await manager.releaseMaturedPosition(intentHash);

      expect(await token.balanceOf(taker.address)).to.eq(beneficiaryBefore);
      expect((await vault.getDeferredStake(intentHash)).staker).to.eq(ZERO);
      expect(await vault.stakeBalance(taker.address)).to.eq(stakeBefore.add(usdc(100)));
      expect(await vault.freeStake(taker.address)).to.eq(stakeBefore.add(usdc(100)));
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("applies deferred custody to manual release and skips the ordinary post hook", async () => {
      const { maker, taker, recipient, escrow, orchestrator, token, vault, manager } =
        await loadFixture(deployFixture);
      await enableDeferred(manager);
      const postHook = await (await ethers.getContractFactory("PostIntentHookV2Mock"))
        .deploy(token.address, orchestrator.address);
      const params = signalParams(escrow, taker.address, usdc(100), PAYPAL, postHook.address) as any;
      params.data = ethers.utils.defaultAbiCoder.encode(["address"], [recipient.address]);
      const signalTx = await orchestrator.connect(taker).signalIntent(params);
      const intentHash = intentHashFrom(await signalTx.wait());
      const recipientBefore = await token.balanceOf(recipient.address);

      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);

      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(usdc(100));
      expect(await token.balanceOf(recipient.address)).to.eq(recipientBefore);
      expect(await token.allowance(orchestrator.address, manager.address)).to.eq(0);
      expect(await token.allowance(orchestrator.address, postHook.address)).to.eq(0);
    });

    it("slashes gross deferred stake after manual release without vesting fees", async () => {
      const { owner, maker, taker, escrow, orchestrator, vault, manager } =
        await loadFixture(deployFixture);
      await enableDeferred(manager);
      await orchestrator.setProtocolFee(precise("0.01"));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(100), PAYPAL);

      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.isManualRelease).to.eq(true);
      expect(position.grossReleasedAmount.sub(position.executableAmount)).to.eq(usdc(1));

      await manager.submitChargeback(
        await chargebackAttestation(manager, intentHash, usdc(100), undefined, {}, false),
      );

      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(100));
      expect(await vault.claimableFees(owner.address)).to.eq(0);
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
      expect(await vault.totalDeferredFees()).to.eq(0);
    });

    it("preserves an ordinary post-intent hook when risk settlement consumes zero", async () => {
      const { taker, recipient, escrow, orchestrator, token, manager } = await loadFixture(deployFixture);
      const postHook = await (await ethers.getContractFactory("PostIntentHookV2Mock"))
        .deploy(token.address, orchestrator.address);
      const params = signalParams(escrow, taker.address, usdc(20), ZELLE, postHook.address) as any;
      params.data = ethers.utils.defaultAbiCoder.encode(["address"], [recipient.address]);
      const signalTx = await orchestrator.connect(taker).signalIntent(params);
      const intentHash = intentHashFrom(await signalTx.wait());
      const before = await token.balanceOf(recipient.address);

      await fulfillIntent(orchestrator, intentHash, usdc(20));

      expect(await token.balanceOf(recipient.address)).to.eq(before.add(usdc(20)));
      expect(await token.allowance(orchestrator.address, manager.address)).to.eq(0);
      expect(await token.allowance(orchestrator.address, postHook.address)).to.eq(0);
    });

    it("pays the exact fee plan before ordinary payout when risk settlement consumes zero", async () => {
      const { owner, maker, taker, recipient, other, escrow, orchestrator, token, vault } =
        await loadFixture(deployFixture);
      await orchestrator.setProtocolFee(precise("0.01"));
      await configureManagerFee(maker, recipient.address, escrow);
      const grossAmount = usdc(20);
      await vault.connect(taker).depositStake(grossAmount);
      const signalTx = await orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        grossAmount,
        PAYPAL,
        ZERO,
        [{ recipient: other.address, fee: precise("0.01") }],
      ));
      const intentHash = intentHashFrom(await signalTx.wait());
      const protocolBefore = await token.balanceOf(owner.address);
      const referrerBefore = await token.balanceOf(other.address);
      const managerBefore = await token.balanceOf(recipient.address);
      const takerBefore = await token.balanceOf(taker.address);

      await expect(fulfillIntent(orchestrator, intentHash, grossAmount))
        .to.emit(orchestrator, "IntentReferralFeeDistributed")
        .withArgs(intentHash, other.address, usdc("0.2"));

      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore.add(usdc("0.2")));
      expect(await token.balanceOf(other.address)).to.eq(referrerBefore.add(usdc("0.2")));
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore.add(usdc("0.2")));
      expect(await token.balanceOf(taker.address)).to.eq(takerBefore.add(usdc("19.4")));
    });

    it("rejects partial pulls and rolls back escrow settlement", async () => {
      const { maker, taker, escrow, orchestrator, token } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await hook.setSettlementPullAmount(usdc(10));

      await expect(fulfillIntent(orchestrator, intentHash, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "InvalidRiskHookSettlementConsumption");
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(taker.address);
      expect(await token.allowance(orchestrator.address, hook.address)).to.eq(0);
    });

    it("rejects over-pulls and callback failures", async () => {
      const { maker, taker, escrow, orchestrator, token } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const overPull = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await hook.setSettlementPullAmount(usdc(20).add(1));
      await expect(fulfillIntent(orchestrator, overPull, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementFailed");
      expect(await token.allowance(orchestrator.address, hook.address)).to.eq(0);

      await hook.setSettlementPullAmount(0);
      await hook.setRevertOnCallback(true);
      await expect(fulfillIntent(orchestrator, overPull, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementFailed");
    });

    it("atomically rolls back nullification, fees, escrow resolution, and allowance on callback failure", async () => {
      const {
        owner,
        maker,
        taker,
        recipient,
        other,
        escrow,
        orchestrator,
        token,
        paymentVerifierRegistry,
        nullifierRegistry,
      } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await hook.setRevertOnCallback(true);
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      await orchestrator.setProtocolFee(precise("0.01"));
      await configureManagerFee(maker, recipient.address, escrow);

      const nullifyingVerifier = await (await ethers.getContractFactory("NullifyingPaymentVerifierMock"))
        .deploy(nullifierRegistry.address, PAYPAL);
      await nullifierRegistry.addWritePermission(nullifyingVerifier.address);
      await paymentVerifierRegistry.removePaymentMethod(PAYPAL);
      await paymentVerifierRegistry.addPaymentMethod(PAYPAL, nullifyingVerifier.address, [USD]);

      const grossAmount = usdc(100);
      const signalTx = await orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        grossAmount,
        PAYPAL,
        ZERO,
        [{ recipient: other.address, fee: precise("0.01") }],
      ));
      const intentHash = intentHashFrom(await signalTx.wait());
      const paymentId = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["bytes32"], [intentHash]));
      const nullifier = ethers.utils.keccak256(
        ethers.utils.solidityPack(["bytes32", "bytes32"], [PAYPAL, paymentId]),
      );
      const depositBefore = await escrow.getDeposit(0);
      const protocolBefore = await token.balanceOf(owner.address);
      const referralBefore = await token.balanceOf(other.address);
      const managerBefore = await token.balanceOf(recipient.address);

      await expect(fulfillIntent(orchestrator, intentHash, grossAmount))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementFailed");

      const depositAfter = await escrow.getDeposit(0);
      expect(await nullifierRegistry.intentHashByNullifier(nullifier)).to.eq(ethers.constants.HashZero);
      expect(await nullifierRegistry.nullifierByIntentHash(intentHash)).to.eq(ethers.constants.HashZero);
      expect(depositAfter.remainingDeposits).to.eq(depositBefore.remainingDeposits);
      expect(depositAfter.outstandingIntentAmount).to.eq(depositBefore.outstandingIntentAmount);
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(taker.address);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore);
      expect(await token.balanceOf(other.address)).to.eq(referralBefore);
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore);
      expect(await token.allowance(orchestrator.address, hook.address)).to.eq(0);
      expect(await token.balanceOf(orchestrator.address)).to.eq(0);
    });

    it("rejects a settlement balance increase", async () => {
      const { maker, taker, escrow, orchestrator, token } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await token.transfer(hook.address, 1);
      await hook.setSettlementTransferAmount(1);
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);

      await expect(fulfillIntent(orchestrator, intentHash, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementBalanceIncreased");
      expect(await token.allowance(orchestrator.address, hook.address)).to.eq(0);
    });

    it("fails closed if a snapshotted hook loses its code", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await ethers.provider.send("hardhat_setCode", [hook.address, "0x"]);

      await expect(fulfillIntent(orchestrator, intentHash, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "InvalidRiskHook");
    });

    it("fails closed if a selected risk hook loses its code before admission", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      await ethers.provider.send("hardhat_setCode", [hook.address, "0x"]);

      await expect(signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("records durable cancellation when a snapshotted hook loses its code", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await ethers.provider.send("hardhat_setCode", [hook.address, "0x"]);

      await expect(orchestrator.connect(taker).cancelIntent(intentHash))
        .to.emit(orchestrator, "RiskHookCallbackFailed")
        .and.to.emit(orchestrator, "IntentCancellationRecorded");
      expect(await orchestrator.getIntentCancellation(intentHash)).to.not.eq(0);
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(ZERO);
    });
  });

  describe("OrchestratorV3 control and recovery surface", () => {
    it("exposes hook snapshots and guarded governance", async () => {
      const { owner, maker, taker, other, escrow, orchestrator, manager } = await loadFixture(deployFixture);
      expect(await orchestrator.getDepositRiskHook(escrow.address, 0)).to.eq(manager.address);
      await expect(orchestrator.connect(other).setRiskCallbackGasLimit(1_000_000))
        .to.be.revertedWith("Ownable: caller is not the owner");
      await expect(orchestrator.setRiskCallbackGasLimit(749_999))
        .to.be.revertedWithCustomError(orchestrator, "RiskCallbackGasLimitTooLow");
      await expect(orchestrator.connect(owner).setRiskCallbackGasLimit(1_000_000))
        .to.emit(orchestrator, "RiskCallbackGasLimitUpdated").withArgs(1_000_000);

      await expect(orchestrator.connect(other).setDepositRiskHook(escrow.address, 0, ZERO))
        .to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
      await expect(orchestrator.connect(maker).setDepositRiskHook(ZERO, 0, ZERO))
        .to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      await expect(orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, other.address))
        .to.be.revertedWithCustomError(orchestrator, "InvalidRiskHook");

      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      expect(await orchestrator.getIntentRiskHook(intentHash)).to.eq(manager.address);
      const riskIntent = await orchestrator.getRiskIntent(intentHash);
      expect(riskIntent.owner).to.eq(taker.address);

      await orchestrator.cleanupOrphanedIntents([ethers.utils.id("unknown-orphan"), intentHash]);
      expect(await orchestrator.getIntentRiskHook(intentHash)).to.eq(manager.address);
    });

    it("fails closed when verified or manual risk settlement reverts", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      await hook.setRevertOnCallback(true);

      const verified = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await expect(fulfillIntent(orchestrator, verified, usdc(20)))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementFailed");
      expect((await orchestrator.getIntent(verified)).owner).to.eq(taker.address);

      const manual = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await expect(orchestrator.connect(maker).releaseFundsToPayer(manual))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookSettlementFailed");
      expect((await orchestrator.getIntent(manual)).owner).to.eq(taker.address);
    });

    it("uses the snapshotted risk hook after the deposit hook is changed", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, ZERO);
      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);
      expect(await hook.settlementCalls()).to.eq(1);
    });

    it("blocks reentry into every guarded V3 lifecycle entrypoint", async () => {
      const { maker, taker, escrow, orchestrator } = await loadFixture(deployFixture);
      const hook = await (await ethers.getContractFactory("OrchestratorV3ReentrantRiskHook")).deploy(
        orchestrator.address, escrow.address,
      );
      await hook.setReenterOnCreate(true);
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      expect(await hook.setterReentrySucceeded()).to.eq(false);
      await fulfillIntent(orchestrator, intentHash, usdc(20));
      expect(await hook.cancelReentrySucceeded()).to.eq(false);
      expect(await hook.cleanupReentrySucceeded()).to.eq(false);
    });
  });
});
