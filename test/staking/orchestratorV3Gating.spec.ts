import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const precise = (amount: string | number) => ethers.utils.parseEther(String(amount));
const DAY = 24 * 60 * 60;
const PAYMENT_A = ethers.utils.id("gated-payment-a");
const PAYMENT_B = ethers.utils.id("gated-payment-b");
const USD = ethers.utils.id("USD");
const EUR = ethers.utils.id("EUR");
const PAYEE = ethers.utils.id("gated-maker-payee");
const ZERO = ethers.constants.AddressZero;

describe("OrchestratorV3 single-use gating authorizations", () => {
  async function deployFixture() {
    const [owner, maker, taker, other, gatingService, referrer] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();

    const token = await (await ethers.getContractFactory("USDCMock"))
      .deploy(usdc(1_000_000), "USD Coin", "USDC");
    const paymentVerifierRegistry = await (await ethers.getContractFactory("PaymentVerifierRegistry")).deploy();
    const escrowRegistry = await (await ethers.getContractFactory("EscrowRegistry")).deploy();
    const relayerRegistry = await (await ethers.getContractFactory("RelayerRegistry")).deploy();
    const orchestratorRegistry = await (await ethers.getContractFactory("OrchestratorRegistry")).deploy();
    const verifier = await (await ethers.getContractFactory("PaymentVerifierMock")).deploy();
    await paymentVerifierRegistry.addPaymentMethod(PAYMENT_A, verifier.address, [USD, EUR]);
    await paymentVerifierRegistry.addPaymentMethod(PAYMENT_B, verifier.address, [USD, EUR]);

    const escrow = await (await ethers.getContractFactory("EscrowV2")).deploy(
      owner.address,
      chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      0,
      100,
      6 * 60 * 60,
    );
    const boundedCall = await (await ethers.getContractFactory("BoundedCall")).deploy();
    const feeLib = await (await ethers.getContractFactory("OrchestratorV3FeeLib")).deploy();
    const postIntentHookExecutor = await (await ethers.getContractFactory("PostIntentHookExecutor")).deploy();
    const callbackRecorder = await (await ethers.getContractFactory("RiskCallbackRecorder")).deploy();
    const riskLib = await (await ethers.getContractFactory("OrchestratorV3RiskLib", {
      libraries: {
        BoundedCall: boundedCall.address,
        RiskCallbackRecorder: callbackRecorder.address,
      },
    })).deploy();
    const validation = await (await ethers.getContractFactory("OrchestratorV3Validation")).deploy();
    const orchestratorFactory = await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        OrchestratorV3FeeLib: feeLib.address,
        PostIntentHookExecutor: postIntentHookExecutor.address,
        OrchestratorV3RiskLib: riskLib.address,
        OrchestratorV3Validation: validation.address,
      },
    });
    const orchestratorArgs = [
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      0,
      owner.address,
      2_000_000,
    ] as const;
    const orchestrator = await orchestratorFactory.deploy(...orchestratorArgs);

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await orchestrator.setAllowMultipleIntents(true);
    await token.transfer(maker.address, usdc(10_000));
    await token.connect(maker).approve(escrow.address, ethers.constants.MaxUint256);

    const currencyConfig = [
      { code: USD, minConversionRate: precise(1), oracleRateConfig: {
        adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
      } },
      { code: EUR, minConversionRate: precise(1), oracleRateConfig: {
        adapter: ZERO, adapterConfig: "0x", spreadBps: 0, maxStaleness: 0,
      } },
    ];
    await escrow.connect(maker).createDeposit({
      token: token.address,
      amount: usdc(5_000),
      intentAmountRange: { min: usdc(1), max: usdc(1_000) },
      paymentMethods: [PAYMENT_A, PAYMENT_B],
      paymentMethodData: [
        { intentGatingService: gatingService.address, payeeDetails: PAYEE, data: "0x" },
        { intentGatingService: gatingService.address, payeeDetails: PAYEE, data: "0x" },
      ],
      currencies: [currencyConfig, currencyConfig],
      delegate: ZERO,
      intentGuardian: ZERO,
      retainOnEmpty: true,
    });
    await escrow.connect(maker).createDeposit({
      token: token.address,
      amount: usdc(1_000),
      intentAmountRange: { min: usdc(1), max: usdc(1_000) },
      paymentMethods: [PAYMENT_A],
      paymentMethodData: [{ intentGatingService: ZERO, payeeDetails: PAYEE, data: "0x" }],
      currencies: [currencyConfig],
      delegate: ZERO,
      intentGuardian: ZERO,
      retainOnEmpty: true,
    });

    return {
      owner,
      maker,
      taker,
      other,
      gatingService,
      referrer,
      escrow,
      orchestrator,
      verifier,
      orchestratorFactory,
      orchestratorArgs,
    };
  }

  async function baseParams(escrow: Contract, taker: string, depositId = 0) {
    return {
      escrow: escrow.address,
      depositId,
      amount: usdc(10),
      to: taker,
      paymentMethod: PAYMENT_A,
      fiatCurrency: USD,
      conversionRate: precise(1),
      referralFees: [] as Array<{ recipient: string; fee: BigNumber }>,
      gatingServiceSignature: "0x",
      signatureExpiration: (await time.latest()) + DAY,
      settlementHook: ZERO,
      preIntentHookData: "0x",
      data: "0x",
    };
  }

  async function signParams(
    orchestrator: Contract,
    params: Awaited<ReturnType<typeof baseParams>>,
    taker: string,
    signer: any,
  ) {
    const messageHash = await orchestrator.getIntentGatingMessageHash(params, taker);
    return {
      ...params,
      gatingServiceSignature: await signer.signMessage(ethers.utils.arrayify(messageHash)),
    };
  }

  async function expectInvalid(
    orchestrator: Contract,
    caller: any,
    params: Awaited<ReturnType<typeof baseParams>>,
  ) {
    await expect(orchestrator.connect(caller).signalIntent(params))
      .to.be.revertedWithCustomError(orchestrator, "InvalidSignature");
  }

  it("consumes the current scoped nonce after a valid authorization", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);

    await expect(orchestrator.connect(taker).signalIntent(params))
      .to.emit(orchestrator, "IntentGatingAuthorizationConsumed")
      .withArgs(taker.address, escrow.address, 0, PAYMENT_A, 0);

    expect(await orchestrator.getIntentGatingNonce(taker.address, escrow.address, 0, PAYMENT_A)).to.eq(1);
  });

  it("rejects replaying a consumed authorization", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await orchestrator.connect(taker).signalIntent(params);

    await expectInvalid(orchestrator, taker, params);
    expect(await orchestrator.getIntentGatingNonce(taker.address, escrow.address, 0, PAYMENT_A)).to.eq(1);
  });

  it("does not consume a nonce for a deposit without a gating service", async () => {
    const { taker, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await baseParams(escrow, taker.address, 1);
    await orchestrator.connect(taker).signalIntent(params);
    expect(await orchestrator.getIntentGatingNonce(taker.address, escrow.address, 1, PAYMENT_A)).to.eq(0);
  });

  it("rolls nonce consumption back when the signature is invalid", async () => {
    const { owner, taker, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, owner);
    await expectInvalid(orchestrator, taker, params);
    expect(await orchestrator.getIntentGatingNonce(taker.address, escrow.address, 0, PAYMENT_A)).to.eq(0);
  });

  it("binds the settlement hook", async () => {
    const { taker, gatingService, escrow, orchestrator, verifier } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, settlementHook: verifier.address });
  });

  it("binds persisted signal hook data", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, data: "0x1234" });
  });

  it("binds ephemeral pre-intent hook data", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, preIntentHookData: "0x1234" });
  });

  it("binds every referral fee", async () => {
    const { taker, gatingService, referrer, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, {
      ...params,
      referralFees: [{ recipient: referrer.address, fee: precise("0.01") }],
    });
  });

  it("binds the recipient", async () => {
    const { taker, other, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, to: other.address });
  });

  it("binds the intent amount", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, amount: params.amount.add(1) });
  });

  it("binds the payment method and its independent nonce scope", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, paymentMethod: PAYMENT_B });
    expect(await orchestrator.getIntentGatingNonce(taker.address, escrow.address, 0, PAYMENT_B)).to.eq(0);
  });

  it("binds the fiat currency", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, fiatCurrency: EUR });
  });

  it("binds the conversion rate", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, conversionRate: params.conversionRate.add(1) });
  });

  it("binds the authorization expiry", async () => {
    const { taker, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, taker, { ...params, signatureExpiration: params.signatureExpiration + 1 });
  });

  it("binds the taker independently from the recipient", async () => {
    const { taker, other, gatingService, escrow, orchestrator } = await loadFixture(deployFixture);
    const params = await signParams(orchestrator, await baseParams(escrow, taker.address), taker.address, gatingService);
    await expectInvalid(orchestrator, other, params);
  });

  it("binds the exact verifying orchestrator", async () => {
    const { taker, escrow, orchestrator, orchestratorFactory, orchestratorArgs } =
      await loadFixture(deployFixture);
    const secondOrchestrator = await orchestratorFactory.deploy(...orchestratorArgs);
    const params = await baseParams(escrow, taker.address);

    expect(await secondOrchestrator.getIntentGatingMessageHash(params, taker.address))
      .to.not.eq(await orchestrator.getIntentGatingMessageHash(params, taker.address));
  });
});
