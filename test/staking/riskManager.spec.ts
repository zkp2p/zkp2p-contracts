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
    const orchestrator = await (await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        PostIntentHookExecutor: postIntentHookExecutor.address,
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
    );
    const deferredHook = await (await ethers.getContractFactory("DeferredPayoutHook")).deploy(
      token.address,
      vault.address,
      manager.address,
      orchestratorRegistry.address,
    );

    await manager.setDeferredPayoutHook(deferredHook.address);
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
        deferredPayoutEnabled: true,
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
      deferredHook,
      orchestratorRegistry,
      verifier,
      attestationVerifier,
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

  async function chargebackAttestation(
    manager: Contract,
    orchestrator: Contract,
    intentHash: string,
    amount: BigNumber,
    nonce = 1,
  ) {
    const now = await time.latest();
    const { chainId } = await ethers.provider.getNetwork();
    return {
      chainId,
      riskManager: manager.address,
      orchestrator: orchestrator.address,
      intentHash,
      paymentMethod: PAYPAL,
      chargebackAmount: amount,
      evidenceId: ethers.utils.id(`evidence-${nonce}`),
      nonce,
      validAfter: now - 1,
      validUntil: now + DAY,
    };
  }

  describe("configuration and exact formulas", () => {
    it("rejects a deferred hook token that differs from the vault token", async () => {
      const { vault, manager, deferredHook, orchestratorRegistry } = await loadFixture(deployFixture);
      const otherToken = await (await ethers.getContractFactory("USDCMock"))
        .deploy(usdc(1), "Other Token", "OTHER");
      await expect((await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        otherToken.address,
        vault.address,
        manager.address,
        orchestratorRegistry.address,
      )).to.be.revertedWithCustomError(deferredHook, "InvalidPayoutToken");
    });

    it("rejects a chargeback reserve above 100 percent", async () => {
      const { manager } = await loadFixture(deployFixture);
      await expect(manager.setPlatformRiskConfig(PAYPAL, {
        enabled: true,
        chargeback: { chargebackable: true, deferredPayoutEnabled: false, reserveBps: 10_001, riskWindow: DAY },
        griefing: { griefingCliff: 1, griefingPenaltyBpsPerHour: 1, baseUnbondedAmount: 0 },
      })).to.be.revertedWithCustomError(manager, "InvalidPlatformConfig");
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
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 5_000, riskWindow: DAY },
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
        chargeback: { chargebackable: true, deferredPayoutEnabled: true, reserveBps: 10_000, riskWindow: 30 * DAY },
        griefing: {
          griefingCliff: 30 * MINUTE,
          griefingPenaltyBpsPerHour: 20,
          baseUnbondedAmount: 0,
        },
      });
      const position = await manager.getRiskPosition(intentHash);
      expect(position.chargebackReserveBps).to.eq(5_000);
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
      await time.increaseTo(createdAt + GRIEFING_CLIFF);
      await orchestrator.connect(taker).cancelIntent(intentHash);
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect(await vault.claimableCompensation((await manager.getRiskPosition(intentHash)).lp)).to.eq(0);
    });

    it("charges the time-linear penalty after the cliff and releases the remainder", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(1_000), PAYPAL);
      const createdAt = (await manager.getRiskPosition(intentHash)).createdAt.toNumber();
      await time.increaseTo(createdAt + 2 * HOUR);
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
      await mock.setRevertOnTerminal(true);
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

    it("starts the coverage window at maker manual release", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);
      const position = await manager.getRiskPosition(intentHash);
      expect(position.coverageDeadline.sub(position.settledAt)).to.eq(30 * DAY);
    });

    it("slashes a partial chargeback and preserves remaining coverage", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const claim = await chargebackAttestation(manager, orchestrator, intentHash, usdc(200));
      await manager.submitChargeback(claim, [], "0x");
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(200));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(300));
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(3);
    });

    it("caps a chargeback request at the remaining coverage", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const claim = await chargebackAttestation(manager, orchestrator, intentHash, usdc(800));
      await manager.submitChargeback(claim, [], "0x");
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(5);
    });

    it("rejects replaying a chargeback nonce", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const first = await chargebackAttestation(manager, orchestrator, intentHash, usdc(100), 7);
      await manager.submitChargeback(first, [], "0x");
      const replay = await chargebackAttestation(manager, orchestrator, intentHash, usdc(100), 7);
      await expect(manager.submitChargeback(replay, [], "0x"))
        .to.be.revertedWithCustomError(manager, "AttestationNonceUsed");
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
      const claim = await chargebackAttestation(manager, orchestrator, intentHash, usdc(100));
      await expect(manager.submitChargeback(claim, [], "0x"))
        .to.be.revertedWithCustomError(manager, "ChargebackWindowClosed");
    });
  });

  describe("deferred payout exception", () => {
    it("reserves only the maximum griefing bond when stake cannot cover chargebacks", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      const position = await manager.getRiskPosition(intentHash);
      expect(position.mode).to.eq(3);
      expect(position.initialReservation).to.eq(usdc("4.025"));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc("4.025"));
    });

    it("holds settled proceeds as chargeback coverage and releases griefing stake", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      await fulfillIntent(orchestrator, intentHash, usdc(700));
      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(700));
      expect((await manager.getRiskPosition(intentHash)).reservedAmount).to.eq(usdc(700));
    });

    it("rejects a self-referral that would reduce deferred proceeds below configured coverage", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const tx = await orchestrator.connect(taker).signalIntent(signalParams(
        escrow,
        taker.address,
        usdc(700),
        PAYPAL,
        deferredHook.address,
        [{ recipient: taker.address, fee: precise("0.5") }],
      ));
      const intentHash = intentHashFrom(await tx.wait());
      await expect(fulfillIntent(orchestrator, intentHash, usdc(700)))
        .to.be.revertedWithCustomError(manager, "InsufficientDeferredPayoutCoverage");
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(1);
      expect(await vault.reservedStake(taker.address)).to.eq(usdc("4.025"));
    });

    it("requires the canonical deferred hook for the exception", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      await expect(signalIntent(orchestrator, escrow, taker, usdc(700), PAYPAL))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("rejects the deferred hook when stake already covers the full reservation", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(700));
      await expect(signalIntent(orchestrator, escrow, taker, usdc(700), PAYPAL, deferredHook.address))
        .to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("slashes deferred proceeds without reducing membership stake", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager, deferredHook } =
        await loadFixture(deployFixture);
      await vault.connect(taker).depositStake(usdc(10));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      await fulfillIntent(orchestrator, intentHash, usdc(700));
      const claim = await chargebackAttestation(manager, orchestrator, intentHash, usdc(200));
      await manager.submitChargeback(claim, [], "0x");
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(10));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(200));
      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(500));
    });
  });
});
