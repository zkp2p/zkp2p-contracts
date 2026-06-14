import "module-alias/register";

import { BigNumber, BytesLike } from "ethers";
import { ethers } from "hardhat";

import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import DeployHelper from "@utils/deploys";
import {
  EscrowRegistry,
  EscrowV2,
  NullifierRegistry,
  OrchestratorRegistry,
  OrchestratorV2,
  PaymentVerifierRegistry,
  RelayerRegistry,
  SimpleAttestationVerifier,
  UnifiedPaymentVerifier,
  USDCMock,
} from "@utils/contracts";
import { MultiAttestationVerifier } from "../../typechain";
import { buildUnifiedPaymentProof, encodeDepositAttestors } from "@utils/unifiedVerifierUtils";
import { Currency } from "@utils/protocolUtils";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";

const expect = getWaffleExpect();
const ZERO_BYTES = "0x";

describe("UnifiedPaymentVerifierV2 Compatibility", () => {
  let owner: Account;
  let attacker: Account;
  let maker: Account;
  let taker: Account;
  let witness: Account;
  let customAttestor: Account;
  let taker2: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let nullifierRegistry: NullifierRegistry;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let attestationVerifier: SimpleAttestationVerifier;
  let verifier: UnifiedPaymentVerifier;

  let chainId: number;
  let paymentMethod: BytesLike;
  let payeeId: BytesLike;
  let intentHash: BytesLike;
  let intentAmount: BigNumber;
  let conversionRate: BigNumber;
  let currency: BytesLike;

  beforeEach(async () => {
    [owner, attacker, maker, taker, witness, customAttestor, taker2] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(ethers.utils.parseUnits("1000000", 6), "USDC", "USDC");
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    nullifierRegistry = await deployer.deployNullifierRegistry();

    chainId = (await ethers.provider.getNetwork()).chainId;

    escrow = await deployer.deployEscrowV2(
      owner.address,
      BigNumber.from(chainId),
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(60 * 60),
    );

    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      BigNumber.from(chainId),
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      owner.address,
    );

    attestationVerifier = await deployer.deploySimpleAttestationVerifier(witness.address);
    verifier = await deployer.deployUnifiedPaymentVerifier(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address,
    );

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await nullifierRegistry.addWritePermission(verifier.address);

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    currency = Currency.USD;
    payeeId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee-v2"));
    conversionRate = ethers.utils.parseEther("1");
    intentAmount = ethers.utils.parseUnits("50", 6);

    await verifier.addPaymentMethod(paymentMethod);
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [currency]);

    await usdcToken.transfer(maker.address, ethers.utils.parseUnits("1000", 6));
    await usdcToken.connect(maker.wallet).approve(escrow.address, ethers.utils.parseUnits("1000", 6));

    await escrow.connect(maker.wallet).createDeposit({
      token: usdcToken.address,
      amount: ethers.utils.parseUnits("500", 6),
      intentAmountRange: { min: ethers.utils.parseUnits("10", 6), max: ethers.utils.parseUnits("200", 6) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{
        intentGatingService: ADDRESS_ZERO,
        payeeDetails: payeeId,
        data: ZERO_BYTES,
      }],
      currencies: [[{ code: currency, minConversionRate: conversionRate, oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    const signalTx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: ZERO,
      amount: intentAmount,
      to: taker.address,
      paymentMethod,
      fiatCurrency: currency,
      conversionRate,
      referralFees: [],
      gatingServiceSignature: ZERO_BYTES,
      signatureExpiration: ZERO,
      postIntentHook: ADDRESS_ZERO,
      preIntentHookData: ZERO_BYTES,
      data: ZERO_BYTES,
    });

    const signalReceipt = await signalTx.wait();
    const intentSignaledEvent = signalReceipt.events?.find((event: any) => event.event === "IntentSignaled");
    intentHash = intentSignaledEvent?.args?.intentHash;
  });

  it("fulfills a V2 intent using UnifiedPaymentVerifier", async () => {
    const intent = await orchestrator.getIntent(intentHash);
    const paymentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp).mul(1000);
    const paymentId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payment-v2"));

    const builtProof = await buildUnifiedPaymentProof({
      verifier: verifier.address,
      witness,
      chainId,
      paymentPaymentMethod: paymentMethod,
      paymentPayeeId: payeeId,
      paymentAmount: intent.amount,
      paymentCurrency: currency,
      paymentTimestamp,
      paymentPaymentId: paymentId,
      attestationIntentHash: intentHash,
      attestationReleaseAmount: intent.amount,
      snapshotIntentHash: intentHash,
      snapshotIntentAmount: intent.amount,
      snapshotIntentPaymentMethod: paymentMethod,
      snapshotIntentFiatCurrency: currency,
      snapshotIntentPayeeDetails: payeeId,
      snapshotIntentConversionRate: intent.conversionRate,
      snapshotIntentSignalTimestamp: intent.timestamp,
      snapshotIntentTimestampBuffer: ZERO,
      intentDepositId: ZERO,
      intentEscrow: escrow.address,
      intentTo: taker.address,
    });

    const takerBalanceBefore = await usdcToken.balanceOf(taker.address);

    await expect(
      orchestrator.connect(attacker.wallet).fulfillIntent({
        paymentProof: builtProof.paymentProof,
        intentHash,
        verificationData: ZERO_BYTES,
        postIntentHookData: ZERO_BYTES,
      }),
    )
      .to.emit(verifier, "PaymentVerified")
      .withArgs(
        intentHash,
        paymentMethod,
        currency,
        builtProof.paymentDetails.amount,
        builtProof.paymentDetails.timestamp,
        builtProof.paymentDetails.paymentId,
        builtProof.paymentDetails.payeeId,
      );

    const takerBalanceAfter = await usdcToken.balanceOf(taker.address);
    expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
  });

  describe("when the attestation verifier is MultiAttestationVerifier", () => {
    let multiAttestationVerifier: MultiAttestationVerifier;

    beforeEach(async () => {
      const verifierFactory = await ethers.getContractFactory("MultiAttestationVerifier", owner.wallet);
      multiAttestationVerifier = (await verifierFactory.deploy([witness.address], 1)) as MultiAttestationVerifier;
      await multiAttestationVerifier.deployed();

      await verifier.connect(owner.wallet).setAttestationVerifier(multiAttestationVerifier.address);
    });

    async function buildProofForIntent(
      targetIntentHash: string,
      signers: Account[],
    ): Promise<string> {
      const intent = await orchestrator.getIntent(targetIntentHash);
      const paymentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp).mul(1000);
      const paymentId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`payment-${targetIntentHash}`));

      const builtProof = await buildUnifiedPaymentProof({
        verifier: verifier.address,
        witness,
        chainId,
        attestationSigners: signers,
        paymentPaymentMethod: paymentMethod,
        paymentPayeeId: payeeId,
        paymentAmount: intent.amount,
        paymentCurrency: currency,
        paymentTimestamp,
        paymentPaymentId: paymentId,
        attestationIntentHash: targetIntentHash,
        attestationReleaseAmount: intent.amount,
        snapshotIntentHash: targetIntentHash,
        snapshotIntentAmount: intent.amount,
        snapshotIntentPaymentMethod: paymentMethod,
        snapshotIntentFiatCurrency: currency,
        snapshotIntentPayeeDetails: payeeId,
        snapshotIntentConversionRate: intent.conversionRate,
        snapshotIntentSignalTimestamp: intent.timestamp,
        snapshotIntentTimestampBuffer: ZERO,
        intentDepositId: intent.depositId,
        intentEscrow: escrow.address,
        intentTo: taker.address,
      });

      return builtProof.paymentProof as string;
    }

    async function fulfill(targetIntentHash: string, paymentProof: string): Promise<any> {
      return orchestrator.connect(attacker.wallet).fulfillIntent({
        paymentProof,
        intentHash: targetIntentHash,
        verificationData: ZERO_BYTES,
        postIntentHookData: ZERO_BYTES,
      });
    }

    it("fulfills a deposit without deposit attestors using the witness", async () => {
      const paymentProof = await buildProofForIntent(intentHash as string, [witness]);

      const takerBalanceBefore = await usdcToken.balanceOf(taker.address);
      await fulfill(intentHash as string, paymentProof);
      const takerBalanceAfter = await usdcToken.balanceOf(taker.address);

      expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
    });

    it("rejects non-empty untagged deposit verifier data instead of falling back", async () => {
      await escrow.connect(maker.wallet).createDeposit({
        token: usdcToken.address,
        amount: ethers.utils.parseUnits("500", 6),
        intentAmountRange: { min: ethers.utils.parseUnits("10", 6), max: ethers.utils.parseUnits("200", 6) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [{
          intentGatingService: ADDRESS_ZERO,
          payeeDetails: payeeId,
          data: "0x1234",
        }],
        currencies: [[{ code: currency, minConversionRate: conversionRate, oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      const signalTx = await orchestrator.connect(taker2.wallet).signalIntent({
        escrow: escrow.address,
        depositId: ONE,
        amount: intentAmount,
        to: taker2.address,
        paymentMethod,
        fiatCurrency: currency,
        conversionRate,
        referralFees: [],
        gatingServiceSignature: ZERO_BYTES,
        signatureExpiration: ZERO,
        postIntentHook: ADDRESS_ZERO,
        preIntentHookData: ZERO_BYTES,
        data: ZERO_BYTES,
      });
      const signalReceipt = await signalTx.wait();
      const intentSignaledEvent = signalReceipt.events?.find((event: any) => event.event === "IntentSignaled");
      const untaggedIntentHash = intentSignaledEvent?.args?.intentHash;
      const paymentProof = await buildProofForIntent(untaggedIntentHash, [witness]);

      await expect(fulfill(untaggedIntentHash, paymentProof)).to.be.revertedWith(
        "MAV: invalid deposit attestors tag"
      );
    });

    describe("when the deposit specifies deposit attestors", () => {
      let depositAttestorsIntentHash: string;

      beforeEach(async () => {
        await escrow.connect(maker.wallet).createDeposit({
          token: usdcToken.address,
          amount: ethers.utils.parseUnits("500", 6),
          intentAmountRange: { min: ethers.utils.parseUnits("10", 6), max: ethers.utils.parseUnits("200", 6) },
          paymentMethods: [paymentMethod],
          paymentMethodData: [{
            intentGatingService: ADDRESS_ZERO,
            payeeDetails: payeeId,
            data: encodeDepositAttestors([customAttestor.address], 1),
          }],
          currencies: [[{ code: currency, minConversionRate: conversionRate, oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false,
        });

        const signalTx = await orchestrator.connect(taker2.wallet).signalIntent({
          escrow: escrow.address,
          depositId: ONE,
          amount: intentAmount,
          to: taker2.address,
          paymentMethod,
          fiatCurrency: currency,
          conversionRate,
          referralFees: [],
          gatingServiceSignature: ZERO_BYTES,
          signatureExpiration: ZERO,
          postIntentHook: ADDRESS_ZERO,
          preIntentHookData: ZERO_BYTES,
          data: ZERO_BYTES,
        });

        const signalReceipt = await signalTx.wait();
        const intentSignaledEvent = signalReceipt.events?.find((event: any) => event.event === "IntentSignaled");
        depositAttestorsIntentHash = intentSignaledEvent?.args?.intentHash;
      });

      it("fulfills with an attestation signed by the depositor's custom attestor", async () => {
        const paymentProof = await buildProofForIntent(depositAttestorsIntentHash, [customAttestor]);

        const takerBalanceBefore = await usdcToken.balanceOf(taker2.address);
        await fulfill(depositAttestorsIntentHash, paymentProof);
        const takerBalanceAfter = await usdcToken.balanceOf(taker2.address);

        expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
      });

      it("fulfills with an attestation signed only by the witness", async () => {
        const paymentProof = await buildProofForIntent(depositAttestorsIntentHash, [witness]);

        const takerBalanceBefore = await usdcToken.balanceOf(taker2.address);
        await fulfill(depositAttestorsIntentHash, paymentProof);
        const takerBalanceAfter = await usdcToken.balanceOf(taker2.address);

        expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
      });

      it("fulfills with an attestation signed by the witness and custom attestor", async () => {
        const paymentProof = await buildProofForIntent(depositAttestorsIntentHash, [witness, customAttestor]);

        const takerBalanceBefore = await usdcToken.balanceOf(taker2.address);
        await fulfill(depositAttestorsIntentHash, paymentProof);
        const takerBalanceAfter = await usdcToken.balanceOf(taker2.address);

        expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
      });

      it("still fulfills the deposit without deposit attestors using the witness", async () => {
        const paymentProof = await buildProofForIntent(intentHash as string, [witness]);

        const takerBalanceBefore = await usdcToken.balanceOf(taker.address);
        await fulfill(intentHash as string, paymentProof);
        const takerBalanceAfter = await usdcToken.balanceOf(taker.address);

        expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
      });
    });

    describe("when the deposit requires 2-of-2 combined attestors", () => {
      let thresholdIntentHash: string;

      beforeEach(async () => {
        await usdcToken.transfer(maker.address, ethers.utils.parseUnits("500", 6));
        await usdcToken.connect(maker.wallet).approve(escrow.address, ethers.utils.parseUnits("500", 6));

        await escrow.connect(maker.wallet).createDeposit({
          token: usdcToken.address,
          amount: ethers.utils.parseUnits("500", 6),
          intentAmountRange: { min: ethers.utils.parseUnits("10", 6), max: ethers.utils.parseUnits("200", 6) },
          paymentMethods: [paymentMethod],
          paymentMethodData: [{
            intentGatingService: ADDRESS_ZERO,
            payeeDetails: payeeId,
            data: encodeDepositAttestors([customAttestor.address], 2),
          }],
          currencies: [[{ code: currency, minConversionRate: conversionRate, oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
          delegate: ADDRESS_ZERO,
          intentGuardian: ADDRESS_ZERO,
          retainOnEmpty: false,
        });

        const signalTx = await orchestrator.connect(taker2.wallet).signalIntent({
          escrow: escrow.address,
          depositId: ONE,
          amount: intentAmount,
          to: taker2.address,
          paymentMethod,
          fiatCurrency: currency,
          conversionRate,
          referralFees: [],
          gatingServiceSignature: ZERO_BYTES,
          signatureExpiration: ZERO,
          postIntentHook: ADDRESS_ZERO,
          preIntentHookData: ZERO_BYTES,
          data: ZERO_BYTES,
        });

        const signalReceipt = await signalTx.wait();
        const intentSignaledEvent = signalReceipt.events?.find((event: any) => event.event === "IntentSignaled");
        thresholdIntentHash = intentSignaledEvent?.args?.intentHash;
      });

      it("fulfills when the witness and custom attestor sign", async () => {
        const paymentProof = await buildProofForIntent(thresholdIntentHash, [customAttestor, witness]);

        const takerBalanceBefore = await usdcToken.balanceOf(taker2.address);
        await fulfill(thresholdIntentHash, paymentProof);
        const takerBalanceAfter = await usdcToken.balanceOf(taker2.address);

        expect(takerBalanceAfter.sub(takerBalanceBefore)).to.eq(intentAmount);
      });

      it("rejects when only one attestor signs", async () => {
        const paymentProof = await buildProofForIntent(thresholdIntentHash, [customAttestor]);

        await expect(fulfill(thresholdIntentHash, paymentProof)).to.be.revertedWith(
          "ThresholdSigVerifierUtils: req threshold exceeds signatures"
        );
      });
    });
  });
});
