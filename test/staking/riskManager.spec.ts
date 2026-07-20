import { expect } from "chai";
import { BigNumber, Contract, ContractReceipt } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const precise = (amount: string | number) => ethers.utils.parseEther(String(amount));
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_INTENT_PERIOD = 6 * HOUR;
const GRIEFING_CLIFF = 15 * MINUTE;
const GRIEFING_SLOPE = 10;
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
      MAX_INTENT_PERIOD,
    );
    const boundedCall = await (await ethers.getContractFactory("BoundedCall")).deploy();
    const postIntentHookExecutor = await (await ethers.getContractFactory("PostIntentHookExecutor")).deploy();
    const riskSettlementExecutor = await (await ethers.getContractFactory("RiskSettlementExecutor", {
      libraries: { BoundedCall: boundedCall.address },
    })).deploy();
    const orchestrator = await (await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        PostIntentHookExecutor: postIntentHookExecutor.address,
        RiskSettlementExecutor: riskSettlementExecutor.address,
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
      griefing: {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        baseUnbondedAmount: usdc(20),
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
      griefing: {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        baseUnbondedAmount: 0,
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
      intentGuardian: makerDelegate.address,
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
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, baseUnbondedAmount: 0 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("accepts risk-manager-owned deferred payout for a chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 10_000, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, baseUnbondedAmount: 0 },
      });
      expect((await manager.getPlatformRiskConfig(PAYPAL)).chargeback.deferredPayoutEnabled).to.eq(true);
    });

    it("rejects a base unbonded amount on a chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, baseUnbondedAmount: 1 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
    });

    it("accepts a reusable base unbonded amount on a non-chargebackable platform", async () => {
      const { manager } = await loadFixture(deployFixture);
      await manager.setPlatformRiskConfig(ZELLE, {
        enabled: true,
        chargeback: { chargebackable: false, deferredPayoutEnabled: false, reserveBps: 0, riskWindow: 0 },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, baseUnbondedAmount: usdc(500) },
      });
      expect((await manager.getPlatformRiskConfig(ZELLE)).griefing.baseUnbondedAmount).to.eq(usdc(500));
    });

    it("calculates the illustrative 5.75 USDC maximum griefing bond", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateMaxGriefingBond(usdc(1_000), MAX_INTENT_PERIOD, {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        baseUnbondedAmount: 0,
      })).to.eq(usdc("5.75"));
    });

    it("subtracts the reusable base before calculating the maximum griefing bond", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateBondedAmount(usdc(700), usdc(500))).to.eq(usdc(200));
      expect(await manager.calculateMaxGriefingBond(usdc(700), MAX_INTENT_PERIOD, {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
        baseUnbondedAmount: usdc(500),
      })).to.eq(usdc("1.15"));
    });

    it("rounds a chargeback reserve upward", async () => {
      const { manager } = await loadFixture(deployFixture);
      expect(await manager.calculateChargebackReserve(101, 5_000)).to.eq(51);
    });

    it("uses the maximum rather than the sum of both reservations", async () => {
      const { manager } = await loadFixture(deployFixture);
      const config = await manager.getPlatformRiskConfig(PAYPAL);
      const result = await manager.calculateRequiredReservation(usdc(1_000), MAX_INTENT_PERIOD, config);
      expect(result.maxGriefingBond).to.eq(usdc("5.75"));
      expect(result.chargebackReserve).to.eq(usdc(1_000));
      expect(result.requiredReservation).to.eq(usdc(1_000));
    });
  });

  describe("base unbonded tranche", () => {
    it("admits an intent at the base without stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(1);
      expect(position.bondedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("reuses the base after cancellation without counter state", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const firstIntentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await orchestrator.connect(taker).cancelIntent(firstIntentHash);
      const secondIntentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      expect((await manager.getRiskPosition(secondIntentHash)).mode).to.eq(1);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("cancels an intent at the base after the griefing cliff without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(GRIEFING_CLIFF + 1);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("expires an intent at the base after the griefing cliff without charging stake", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(20), ZELLE);
      await time.increase(MAX_INTENT_PERIOD + 1);
      await escrow.pruneExpiredIntents(0);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.status).to.eq(2);
      expect(position.slashedAmount).to.eq(0);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
    });

    it("applies the base tranche to a larger intent and bonds only the excess", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(21), ZELLE);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(2);
      expect(position.intentAmount).to.eq(usdc(21));
      expect(position.bondedAmount).to.eq(usdc(1));
      expect(position.maxGriefingBond).to.eq(usdc("0.00575"));
    });

    it("reuses the base concurrently across delegated takers", async () => {
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
        griefing: {
          griefingCliff: GRIEFING_CLIFF,
          griefingPenaltyBpsPerHour: GRIEFING_SLOPE,
          baseUnbondedAmount: 0,
        },
      });
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_000, riskWindow: 30 * DAY },
        griefing: {
          griefingCliff: 30 * MINUTE,
          griefingPenaltyBpsPerHour: 20,
          baseUnbondedAmount: 0,
        },
      });
      const position = await manager.getRiskPosition(intentHash);
      expect(position.chargebackReserveBps).to.eq(10_000);
      expect(position.riskWindow).to.eq(DAY);
      expect(position.griefingCliff).to.eq(GRIEFING_CLIFF);
    });
  });

  describe("cancellation penalties", () => {
    it("releases the complete reservation when cancelled at the cliff", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.setNextBlockTimestamp(createdAt + GRIEFING_CLIFF);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await vault.claimableCompensation((await manager.getRiskPosition(intentHash)).lp)).to.eq(0);
    });

    it("charges the time-linear penalty after the cliff and releases the remainder", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.setNextBlockTimestamp(createdAt + 2 * HOUR);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc("1.75"));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc("998.25"));
      expect((await manager.getRiskPosition(intentHash)).slashedAmount).to.eq(usdc("1.75"));
    });

    it("caps a guardian-extended intent penalty at the snapshotted maximum period", async () => {
      const { maker, makerDelegate, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), ZELLE);
      await escrow.connect(makerDelegate).extendIntentExpiry(0, intentHash, DAY);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.increaseTo(createdAt + DAY);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc("5.635"));
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
    it("releases a non-chargebackable griefing bond on fulfillment", async () => {
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
      expect(position.coverageDeadline).to.be.gt(0);
      expect(position.reservedAmount).to.eq(usdc(500));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(500));
      expect(await token.balanceOf(taker.address)).to.eq(balanceBefore.add(usdc(500)));
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

    it("rejects chargebacks without a verified payment binding and mismatched identifiers", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const manualHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await orchestrator.connect(maker).releaseFundsToPayer(manualHash);
      await expect(manager.submitChargeback(
        await chargebackAttestation(manager, manualHash, usdc(500), undefined, {}, false),
      )).to.be.revertedWithCustomError(manager, "InvalidPaymentBinding");

      const verifiedHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, verifiedHash, usdc(500));
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
        griefing: {
          griefingCliff: GRIEFING_CLIFF,
          griefingPenaltyBpsPerHour: 0,
          baseUnbondedAmount: 0,
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
      const payout = await vault.getDeferredPayout(intentHash);
      expect(position.grossReleasedAmount).to.eq(usdc(100));
      expect(position.executableAmount).to.eq(usdc(100));
      expect(position.coveredAmount).to.eq(usdc(100));
      expect(position.deferredPayoutAmount).to.eq(usdc(100));
      expect(payout.amount).to.eq(usdc(100));
      expect(await token.balanceOf(taker.address)).to.eq(recipientBefore);
      expect(await token.allowance(orchestrator.address, manager.address)).to.eq(0);
    });

    it("defers the exact post-fee amount across protocol, referral, and manager rounding", async () => {
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
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore.add(feeEach));
      expect(await token.balanceOf(other.address)).to.eq(referrerBefore.add(feeEach));
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore.add(feeEach));
      expect(position.grossReleasedAmount).to.eq(grossAmount);
      expect(position.executableAmount).to.eq(executableAmount);
      expect(position.coveredAmount).to.eq(executableAmount);
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(executableAmount);
    });

    it("converts exact net deferred custody into LP compensation without reusing it as stake", async () => {
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
      const beneficiaryStakeBefore = await vault.stakeBalance(taker.address);
      const beneficiaryFreeStakeBefore = await vault.freeStake(taker.address);

      await fulfillIntent(orchestrator, intentHash, grossAmount);

      const feeAmount = usdc(1);
      const executableAmount = usdc(97);
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore.add(feeAmount));
      expect(await token.balanceOf(other.address)).to.eq(referralBefore.add(feeAmount));
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore.add(feeAmount));
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(executableAmount);
      expect(await vault.stakeBalance(taker.address)).to.eq(beneficiaryStakeBefore);
      expect(await vault.freeStake(taker.address)).to.eq(beneficiaryFreeStakeBefore);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());

      await manager.submitChargeback(await chargebackAttestation(manager, intentHash, grossAmount));

      const payout = await vault.getDeferredPayout(intentHash);
      expect(payout.beneficiary).to.eq(ZERO);
      expect(payout.amount).to.eq(0);
      expect(await vault.claimableCompensation(maker.address)).to.eq(executableAmount);
      await expect(vault.connect(taker).withdrawDeferredPayout(intentHash, taker.address))
        .to.be.revertedWithCustomError(vault, "DeferredPayoutNotFound");
      expect(await token.balanceOf(owner.address)).to.eq(protocolBefore.add(feeAmount));
      expect(await token.balanceOf(other.address)).to.eq(referralBefore.add(feeAmount));
      expect(await token.balanceOf(recipient.address)).to.eq(managerBefore.add(feeAmount));
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());

      const makerBefore = await token.balanceOf(maker.address);
      await vault.connect(maker).withdrawCompensation(maker.address);
      expect(await token.balanceOf(maker.address)).to.eq(makerBefore.add(executableAmount));
      expect(await vault.claimableCompensation(maker.address)).to.eq(0);
      expect(await token.balanceOf(vault.address)).to.eq(await vault.totalLiabilities());
      expect(await vault.stakeBalance(taker.address)).to.eq(beneficiaryStakeBefore);
      expect(await vault.freeStake(taker.address)).to.eq(beneficiaryFreeStakeBefore);
    });

    it("releases matured deferred custody for beneficiary withdrawal without creating stake", async () => {
      const { taker, escrow, orchestrator, token, vault, manager } = await loadFixture(deployFixture);
      await enableDeferred(manager);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(100), PAYPAL);
      const stakeBefore = await vault.stakeBalance(taker.address);
      const beneficiaryBefore = await token.balanceOf(taker.address);

      await fulfillIntent(orchestrator, intentHash, usdc(100));
      const deadline = (await manager.getRiskPosition(intentHash)).coverageDeadline.toNumber();
      await time.increaseTo(deadline);
      await manager.releaseMaturedPosition(intentHash);
      await vault.connect(taker).withdrawDeferredPayout(intentHash, taker.address);

      expect(await token.balanceOf(taker.address)).to.eq(beneficiaryBefore.add(usdc(100)));
      expect((await vault.getDeferredPayout(intentHash)).beneficiary).to.eq(ZERO);
      expect(await vault.stakeBalance(taker.address)).to.eq(stakeBefore);
      expect(await vault.freeStake(taker.address)).to.eq(stakeBefore);
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

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(100));
      expect(await token.balanceOf(recipient.address)).to.eq(recipientBefore);
      expect(await token.allowance(orchestrator.address, manager.address)).to.eq(0);
      expect(await token.allowance(orchestrator.address, postHook.address)).to.eq(0);
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
