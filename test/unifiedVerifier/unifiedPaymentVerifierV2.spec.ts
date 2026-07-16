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
import { buildUnifiedPaymentProof } from "@utils/unifiedVerifierUtils";
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
    [owner, attacker, maker, taker, witness] = await getAccounts();
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
      settlementHook: ADDRESS_ZERO,
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
        settlementHookData: ZERO_BYTES,
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
});
