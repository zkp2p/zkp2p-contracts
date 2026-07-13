import { expect } from "chai";
import { BigNumber, Contract, ContractReceipt } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const precise = (amount: string | number) => ethers.utils.parseEther(String(amount));
const DAY = 24 * 60 * 60;
const PAYPAL = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));
const ZELLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle"));
const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const PAYEE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("maker-payee"));
const ZERO = ethers.constants.AddressZero;

describe("RiskTierManager and OrchestratorV3", () => {
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
      DAY,
    );
    const orchestrator = await (await ethers.getContractFactory("OrchestratorV3")).deploy(
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
    const manager = await (await ethers.getContractFactory("RiskTierManager")).deploy(
      owner.address,
      orchestrator.address,
      vault.address,
      attestationVerifier.address,
      [usdc(100), usdc(500), usdc(1_000), usdc(5_000)],
      [1, 2, 5, 10, 100],
      DAY,
      DAY,
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
      chargebackable: false,
      deferredPayoutEnabled: false,
      reserveBps: 0,
      riskWindow: 0,
      tierCaps: [usdc(100), usdc(250), usdc(500), usdc(1_000), usdc(5_000)],
    });
    await manager.setPlatformRiskConfig(PAYPAL, {
      enabled: true,
      chargebackable: true,
      deferredPayoutEnabled: true,
      reserveBps: 10_000,
      riskWindow: 30 * DAY,
      tierCaps: [0, 0, usdc(750), usdc(1_875), usdc(3_750)],
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
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: { adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0 } }],
        [{ code: USD, minConversionRate: precise(1), oracleRateConfig: { adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0 } }],
      ],
      delegate: makerDelegate.address,
      intentGuardian: ZERO,
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
    takerAddress: string,
    amount: BigNumber,
    paymentMethod: string,
    postIntentHook = ZERO,
  ) {
    return {
      escrow: escrow.address,
      depositId: 0,
      amount,
      to: takerAddress,
      paymentMethod,
      fiatCurrency: USD,
      conversionRate: precise(1),
      referralFees: [],
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
    recipientAddress = taker.address,
  ): Promise<string> {
    const tx = await orchestrator
      .connect(taker)
      .signalIntent(signalParams(escrow, recipientAddress, amount, paymentMethod, postIntentHook));
    return intentHashFrom(await tx.wait());
  }

  async function fulfillIntent(
    orchestrator: Contract,
    intentHash: string,
    releaseAmount: BigNumber,
  ) {
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

  describe("tier policy", () => {
    it("derives all five tiers from current stake thresholds", async () => {
      const { manager } = await deployFixture();

      expect(await manager.getTierForStake(0)).to.eq(0);
      expect(await manager.getTierForStake(usdc(100))).to.eq(1);
      expect(await manager.getTierForStake(usdc(500))).to.eq(2);
      expect(await manager.getTierForStake(usdc(1_000))).to.eq(3);
      expect(await manager.getTierForStake(usdc(5_000))).to.eq(4);
    });

    it("rejects non-increasing tier thresholds", async () => {
      const { manager } = await deployFixture();

      await expect(manager.setTierThresholds([1, 2, 2, 4])).to.be.revertedWithCustomError(
        manager,
        "InvalidTierThresholds",
      );
    });

    it("reports stake, reservations, exit state, tier, and active intent count", async () => {
      const { taker, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));

      const state = await manager.getTakerState(taker.address);

      expect(state.tier).to.eq(2);
      expect(state.totalStake).to.eq(usdc(500));
      expect(state.reserved).to.eq(0);
      expect(state.free).to.eq(usdc(500));
      expect(state.exiting).to.eq(false);
      expect(state.activeIntents).to.eq(0);
    });
  });

  describe("deposit risk hook selection", () => {
    it("lets the deposit delegate update the hook for future intents", async () => {
      const { makerDelegate, escrow, orchestrator, manager } = await deployFixture();

      await orchestrator.connect(makerDelegate).setDepositRiskHook(escrow.address, 0, ZERO);
      await orchestrator.connect(makerDelegate).setDepositRiskHook(escrow.address, 0, manager.address);

      expect(await orchestrator.getDepositRiskHook(escrow.address, 0)).to.eq(manager.address);
    });

    it("rejects hook updates from an unrelated wallet", async () => {
      const { other, escrow, orchestrator, manager } = await deployFixture();

      await expect(
        orchestrator.connect(other).setDepositRiskHook(escrow.address, 0, manager.address),
      ).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
    });

    it("snapshots the selected hook without changing the V2 Intent struct", async () => {
      const { maker, taker, escrow, orchestrator, manager } = await deployFixture();
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);

      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, ZERO);

      expect(await orchestrator.getIntentRiskHook(intentHash)).to.eq(manager.address);
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(taker.address);
      expect((await orchestrator.getRiskIntent(intentHash)).owner).to.eq(taker.address);
      expect(await orchestrator.getAccountIntentCount(taker.address)).to.eq(1);
    });
  });

  describe("callback failure policy", () => {
    it("fails closed when admission callback reverts", async () => {
      const { maker, taker, escrow, orchestrator } = await deployFixture();
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await hook.setRevertOnCreate(true);
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(50), ZELLE)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");

      expect(await orchestrator.getAccountIntents(taker.address)).to.deep.eq([]);
    });

    it("fails open on cancellation callback and leaves no active intent", async () => {
      const { maker, taker, escrow, orchestrator } = await deployFixture();
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);
      await hook.setRevertOnTerminal(true);

      const revertData = ethers.utils.hexConcat([
        "0x08c379a0",
        ethers.utils.defaultAbiCoder.encode(["string"], ["risk cancellation failed"]),
      ]);

      await expect(orchestrator.connect(taker).cancelIntent(intentHash))
        .to.emit(orchestrator, "RiskHookCallbackFailed")
        .withArgs(intentHash, hook.address, hook.interface.getSighash("onIntentCancelled"), revertData);

      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(ZERO);
    });

    it("caps terminal revert data so a malicious hook cannot block cancellation", async () => {
      const { maker, taker, escrow, orchestrator } = await deployFixture();
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);
      await hook.setTerminalRevertDataSize(32_768);

      const receipt = await (await orchestrator.connect(taker).cancelIntent(intentHash)).wait();
      const failureEvent = receipt.events?.find(({ event }) => event === "RiskHookCallbackFailed");

      expect(failureEvent?.args?.revertData).to.have.lengthOf(2 + 2 * 2_048);
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(ZERO);
    });

    it("fails open on fulfillment accounting while completing verified settlement", async () => {
      const { maker, taker, escrow, orchestrator, token } = await deployFixture();
      const hook = await (await ethers.getContractFactory("IntentRiskHookMock")).deploy();
      await orchestrator.connect(maker).setDepositRiskHook(escrow.address, 0, hook.address);
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);
      await hook.setRevertOnTerminal(true);
      const balanceBefore = await token.balanceOf(taker.address);

      await fulfillIntent(orchestrator, intentHash, usdc(50));

      expect((await token.balanceOf(taker.address)).sub(balanceBefore)).to.eq(usdc(50));
      expect((await orchestrator.getIntent(intentHash)).owner).to.eq(ZERO);
    });

    it("reconciles durable settlement after the risk manager terminal callback fails", async () => {
      const { owner, taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      await vault.proposeController(owner.address);
      await time.increase(DAY);
      await vault.acceptController();

      await expect(fulfillIntent(orchestrator, intentHash, usdc(300)))
        .to.emit(orchestrator, "RiskHookCallbackFailed");

      expect((await manager.getRiskPosition(intentHash)).releasedAmount).to.eq(0);
      expect((await vault.getReservation(intentHash)).amount).to.eq(usdc(500));
      expect((await orchestrator.getIntentSettlement(intentHash)).releasedAmount).to.eq(usdc(300));

      await vault.proposeController(manager.address);
      await time.increase(DAY);
      await manager.acceptVaultController();
      await manager.reconcileSettlement(intentHash);

      const position = await manager.getRiskPosition(intentHash);
      expect(position.releasedAmount).to.eq(usdc(300));
      expect(position.reservedAmount).to.eq(usdc(300));
      expect(position.settledAt).to.not.eq(0);
    });
  });

  describe("intent admission", () => {
    it("allows a zero-stake Peasant on a configured non-chargebackable platform", async () => {
      const { taker, escrow, orchestrator, manager } = await deployFixture();

      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);
      const position = await manager.getRiskPosition(intentHash);

      expect(position.mode).to.eq(0);
      expect(position.status).to.eq(1);
      expect(position.taker).to.eq(taker.address);
    });

    it("rejects a Peasant on a chargebackable platform", async () => {
      const { taker, escrow, orchestrator } = await deployFixture();

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(50), PAYPAL)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("rejects an amount above the wallet tier cap", async () => {
      const { taker, escrow, orchestrator, vault } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(751), PAYPAL)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("reserves free stake for a chargebackable intent", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));

      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      expect(await vault.reservedStake(taker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(intentHash)).mode).to.eq(1);
    });

    it("enforces the Peasant one-active-intent ceiling", async () => {
      const { taker, escrow, orchestrator } = await deployFixture();
      await signalIntent(orchestrator, escrow, taker, usdc(50), ZELLE);

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(50), ZELLE)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("blocks all new intents as soon as full exit is requested", async () => {
      const { taker, escrow, orchestrator, vault } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));
      await vault.connect(taker).requestExit();

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(50), ZELLE)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });
  });

  describe("terminal lifecycle accounting", () => {
    it("releases stake immediately when the taker cancels", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      await orchestrator.connect(taker).cancelIntent(intentHash);

      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(2);
    });

    it("reduces stake reservation to a verified partial release amount", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      await fulfillIntent(orchestrator, intentHash, usdc(200));

      const position = await manager.getRiskPosition(intentHash);
      expect(position.releasedAmount).to.eq(usdc(200));
      expect(position.reservedAmount).to.eq(usdc(200));
      expect(await vault.reservedStake(taker.address)).to.eq(usdc(200));
    });

    it("starts the chargeback window on maker manual release", async () => {
      const { maker, taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);

      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);

      const position = await manager.getRiskPosition(intentHash);
      expect(position.releasedAmount).to.eq(usdc(500));
      expect(position.slashDeadline).to.be.gt(0);
    });

    it("releases matured stake collateral permissionlessly", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      await fulfillIntent(orchestrator, intentHash, usdc(500));
      const position = await manager.getRiskPosition(intentHash);
      await time.increaseTo(position.releaseTime.toNumber());

      await manager.releaseMaturedPosition(intentHash);

      expect(await vault.reservedStake(taker.address)).to.eq(0);
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(3);
    });
  });

  describe("deferred payout mode", () => {
    it("requires the approved deferred hook when free stake is insufficient", async () => {
      const { taker, escrow, orchestrator, vault } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));

      await expect(
        orchestrator.connect(taker).signalIntent(signalParams(escrow, taker.address, usdc(700), PAYPAL)),
      ).to.be.revertedWithCustomError(orchestrator, "RiskHookAdmissionFailed");
    });

    it("holds proof-fulfilled net proceeds in the vault without increasing membership stake", async () => {
      const { taker, escrow, orchestrator, vault, manager, deferredHook } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );

      await fulfillIntent(orchestrator, intentHash, usdc(700));

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(700));
      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(500));
      expect((await manager.getRiskPosition(intentHash)).reservedAmount).to.eq(usdc(700));
    });

    it("assigns deferred proceeds to the intent recipient when it differs from the taker", async () => {
      const { taker, recipient, escrow, orchestrator, vault, deferredHook } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
        recipient.address,
      );

      await fulfillIntent(orchestrator, intentHash, usdc(700));

      expect((await vault.getDeferredPayout(intentHash)).beneficiary).to.eq(recipient.address);
    });

    it("rejects a registered orchestrator that is not the manager's canonical orchestrator", async () => {
      const { other, token, escrow, orchestratorRegistry, deferredHook } = await deployFixture();
      await orchestratorRegistry.addOrchestrator(other.address);

      await expect(deferredHook.connect(other).execute({
        intentHash: ethers.utils.id("foreign-intent"),
        token: token.address,
        executableAmount: usdc(1),
        intent: {
          owner: other.address,
          to: other.address,
          escrow: escrow.address,
          depositId: 0,
          amount: usdc(1),
          timestamp: await time.latest(),
          paymentMethod: PAYPAL,
          fiatCurrency: USD,
          conversionRate: precise(1),
          payeeId: PAYEE,
          signalHookData: "0x",
        },
      }, "0x")).to.be.revertedWithCustomError(deferredHook, "UnauthorizedOrchestrator");
    });

    it("routes maker-manually-released proceeds through the required deferred hook", async () => {
      const { maker, taker, escrow, orchestrator, vault, deferredHook } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );

      await orchestrator.connect(maker).releaseFundsToPayer(intentHash);

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(700));
    });

    it("honors the snapshotted deferred hook after governance rotates the canonical hook", async () => {
      const {
        taker,
        escrow,
        orchestrator,
        vault,
        manager,
        deferredHook,
        token,
        orchestratorRegistry,
      } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(500));
      const intentHash = await signalIntent(
        orchestrator,
        escrow,
        taker,
        usdc(700),
        PAYPAL,
        deferredHook.address,
      );
      const replacementHook = await (await ethers.getContractFactory("DeferredPayoutHook")).deploy(
        token.address,
        vault.address,
        manager.address,
        orchestratorRegistry.address,
      );
      await manager.setDeferredPayoutHook(replacementHook.address);

      await fulfillIntent(orchestrator, intentHash, usdc(700));

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(700));
    });
  });

  describe("chargeback settlement", () => {
    async function fulfilledStakeBackedPosition() {
      const fixture = await deployFixture();
      await fixture.vault.connect(fixture.taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(
        fixture.orchestrator,
        fixture.escrow,
        fixture.taker,
        usdc(500),
        PAYPAL,
      );
      await fulfillIntent(fixture.orchestrator, intentHash, usdc(500));
      return { ...fixture, intentHash };
    }

    async function attestation(manager: Contract, orchestrator: Contract, intentHash: string, amount: BigNumber, nonce = 1) {
      const now = await time.latest();
      const network = await ethers.provider.getNetwork();
      return {
        chainId: network.chainId,
        riskTierManager: manager.address,
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

    it("rejects chargeback slashing before the intent has settled", async () => {
      const { taker, escrow, orchestrator, vault, manager } = await deployFixture();
      await vault.connect(taker).depositStake(usdc(1_000));
      const intentHash = await signalIntent(orchestrator, escrow, taker, usdc(500), PAYPAL);
      const claim = await attestation(manager, orchestrator, intentHash, usdc(200));

      await expect(manager.submitChargeback(claim, [], "0x"))
        .to.be.revertedWithCustomError(manager, "PositionNotSettled");

      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(1_000));
    });

    it("slashes the minimum of attested loss, released amount, and reserved collateral", async () => {
      const { maker, taker, orchestrator, vault, manager, intentHash } = await fulfilledStakeBackedPosition();
      const claim = await attestation(manager, orchestrator, intentHash, usdc(200));

      await manager.submitChargeback(claim, [], "0x");

      expect(await vault.stakeBalance(taker.address)).to.eq(usdc(800));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(200));
      expect((await manager.getRiskPosition(intentHash)).status).to.eq(4);
    });

    it("caps an oversized attested loss at reserved collateral", async () => {
      const { maker, orchestrator, vault, manager, intentHash } = await fulfilledStakeBackedPosition();
      const claim = await attestation(manager, orchestrator, intentHash, usdc(900));

      await manager.submitChargeback(claim, [], "0x");

      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(500));
    });

    it("rejects a chargeback at the exact slash deadline", async () => {
      const { orchestrator, manager, intentHash } = await fulfilledStakeBackedPosition();
      const position = await manager.getRiskPosition(intentHash);
      const claim = await attestation(manager, orchestrator, intentHash, usdc(100));
      claim.validUntil = position.slashDeadline.add(DAY).toNumber();
      await time.increaseTo(position.slashDeadline.toNumber());

      await expect(manager.submitChargeback(claim, [], "0x")).to.be.revertedWithCustomError(
        manager,
        "ChargebackWindowClosed",
      );
    });

    it("rejects an attestation when the verifier returns false", async () => {
      const { orchestrator, manager, attestationVerifier, intentHash } = await fulfilledStakeBackedPosition();
      await attestationVerifier.setResult(false);
      const claim = await attestation(manager, orchestrator, intentHash, usdc(100));

      await expect(manager.submitChargeback(claim, [], "0x")).to.be.revertedWithCustomError(
        manager,
        "AttestationVerificationFailed",
      );
    });
  });
});
