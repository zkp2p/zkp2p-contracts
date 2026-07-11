import "module-alias/register";

import { BigNumber, BytesLike } from "ethers";
import * as hre from "hardhat";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
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
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import { Account } from "@utils/test/types";
import { buildUnifiedPaymentProof } from "@utils/unifiedVerifierUtils";
import { Currency } from "@utils/protocolUtils";
import {
  GENERIC_ZELLE_PAYMENT_METHOD_HASH,
  RETIRED_ZELLE_PAYMENT_METHODS,
  retireLegacyZelleVerifierRegistrations,
} from "../../deploy/26_retire_legacy_zelle_payment_methods";

const { ethers } = hre;
const expect = getWaffleExpect();
const ZERO_BYTES = "0x";

describe("Retire legacy Zelle payment methods", () => {
  let owner: Account;
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
  let legacyUnifiedPaymentVerifier: UnifiedPaymentVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;

  let chainId: number;
  let legacyDepositIds: BigNumber[];
  const currency = Currency.USD;
  const payeeId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zelle-payee"));
  const conversionRate = ether(1);

  async function createDeposit(paymentMethod: BytesLike, amount: BigNumber): Promise<BigNumber> {
    const depositId = await escrow.depositCounter();
    await escrow.connect(maker.wallet).createDeposit({
      token: usdcToken.address,
      amount,
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{
        intentGatingService: ADDRESS_ZERO,
        payeeDetails: payeeId,
        data: ZERO_BYTES,
      }],
      currencies: [[{
        code: currency,
        minConversionRate: conversionRate,
        oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
      }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
    return depositId;
  }

  async function signalIntent(depositId: BigNumber, paymentMethod: BytesLike, amount: BigNumber) {
    const params = await createSignalIntentParams(
      orchestrator.address,
      escrow.address,
      depositId,
      amount,
      taker.address,
      paymentMethod,
      currency,
      conversionRate,
      ADDRESS_ZERO,
      ZERO,
      null,
      String(chainId),
      ADDRESS_ZERO,
      ZERO_BYTES,
      undefined,
      ZERO_BYTES
    );
    return orchestrator.connect(taker.wallet).signalIntent(params);
  }

  beforeEach(async () => {
    [owner, maker, taker, witness] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    chainId = (await ethers.provider.getNetwork()).chainId;

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    nullifierRegistry = await deployer.deployNullifierRegistry();

    escrow = await deployer.deployEscrowV2(
      owner.address,
      BigNumber.from(chainId),
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(60 * 60)
    );
    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      BigNumber.from(chainId),
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      owner.address
    );

    attestationVerifier = await deployer.deploySimpleAttestationVerifier(witness.address);
    legacyUnifiedPaymentVerifier = await deployer.deployUnifiedPaymentVerifier(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address
    );
    unifiedPaymentVerifierV2 = await deployer.deployUnifiedPaymentVerifier(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address
    );

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await nullifierRegistry.addWritePermission(unifiedPaymentVerifierV2.address);

    await unifiedPaymentVerifierV2.addPaymentMethod(GENERIC_ZELLE_PAYMENT_METHOD_HASH);
    await paymentVerifierRegistry.addPaymentMethod(
      GENERIC_ZELLE_PAYMENT_METHOD_HASH,
      unifiedPaymentVerifierV2.address,
      [currency]
    );

    for (const { hash } of RETIRED_ZELLE_PAYMENT_METHODS) {
      await legacyUnifiedPaymentVerifier.addPaymentMethod(hash);
      await unifiedPaymentVerifierV2.addPaymentMethod(hash);
      await paymentVerifierRegistry.addPaymentMethod(hash, unifiedPaymentVerifierV2.address, [currency]);
    }

    await usdcToken.transfer(maker.address, usdc(2_000));
    await usdcToken.connect(maker.wallet).approve(escrow.address, usdc(2_000));
    legacyDepositIds = [];
    for (const { hash } of RETIRED_ZELLE_PAYMENT_METHODS) {
      legacyDepositIds.push(await createDeposit(hash, usdc(300)));
    }
  });

  it("hard cuts all legacy methods without deleting deposits and keeps generic Zelle functional", async () => {
    expect(GENERIC_ZELLE_PAYMENT_METHOD_HASH).to.eq(
      "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3"
    );

    const migrationStartBlock = await ethers.provider.getBlockNumber();
    const nonceBefore = await owner.wallet.getTransactionCount();
    await retireLegacyZelleVerifierRegistrations(
      hre,
      {
        paymentVerifierRegistry,
        legacyUnifiedPaymentVerifier,
        unifiedPaymentVerifierV2,
      },
      unifiedPaymentVerifierV2.address
    );
    const nonceAfter = await owner.wallet.getTransactionCount();
    expect(nonceAfter - nonceBefore).to.eq(9);

    const registryEvents = await paymentVerifierRegistry.queryFilter(
      paymentVerifierRegistry.filters.PaymentMethodRemoved(),
      migrationStartBlock + 1
    );
    const legacyVerifierEvents = await legacyUnifiedPaymentVerifier.queryFilter(
      legacyUnifiedPaymentVerifier.filters.PaymentMethodRemoved(),
      migrationStartBlock + 1
    );
    const v2VerifierEvents = await unifiedPaymentVerifierV2.queryFilter(
      unifiedPaymentVerifierV2.filters.PaymentMethodRemoved(),
      migrationStartBlock + 1
    );
    expect(registryEvents).to.have.length(3);
    expect(legacyVerifierEvents).to.have.length(3);
    expect(v2VerifierEvents).to.have.length(3);
    expect(registryEvents[2].blockNumber).to.be.lessThan(legacyVerifierEvents[0].blockNumber);

    const legacyPaymentMethods = await legacyUnifiedPaymentVerifier.getPaymentMethods();
    const v2PaymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
    for (const { hash } of RETIRED_ZELLE_PAYMENT_METHODS) {
      expect(await paymentVerifierRegistry.isPaymentMethod(hash)).to.be.false;
      expect(await paymentVerifierRegistry.getVerifier(hash)).to.eq(ADDRESS_ZERO);
      expect(legacyPaymentMethods).to.not.include(hash);
      expect(v2PaymentMethods).to.not.include(hash);
    }

    expect(await paymentVerifierRegistry.isPaymentMethod(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.be.true;
    expect(await paymentVerifierRegistry.getVerifier(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.eq(
      unifiedPaymentVerifierV2.address
    );
    expect(v2PaymentMethods).to.include(GENERIC_ZELLE_PAYMENT_METHOD_HASH);

    for (const [index, { hash }] of RETIRED_ZELLE_PAYMENT_METHODS.entries()) {
      const existingLegacyDeposit = await escrow.getDeposit(legacyDepositIds[index]);
      expect(existingLegacyDeposit.depositor).to.eq(maker.address);
      expect(existingLegacyDeposit.remainingDeposits).to.eq(usdc(300));

      await expect(
        createDeposit(hash, usdc(100))
      ).to.be.revertedWithCustomError(escrow, "PaymentMethodNotWhitelisted");
      await expect(
        signalIntent(legacyDepositIds[index], hash, usdc(50))
      ).to.be.revertedWithCustomError(orchestrator, "PaymentMethodDoesNotExist");
    }
    expect(await usdcToken.balanceOf(escrow.address)).to.eq(usdc(900));

    const makerBalanceBeforeWithdrawal = await usdcToken.balanceOf(maker.address);
    for (const depositId of legacyDepositIds) {
      await escrow.connect(maker.wallet).withdrawDeposit(depositId);
    }
    expect((await usdcToken.balanceOf(maker.address)).sub(makerBalanceBeforeWithdrawal)).to.eq(usdc(900));

    const genericDepositId = await createDeposit(GENERIC_ZELLE_PAYMENT_METHOD_HASH, usdc(300));
    const signalTx = await signalIntent(genericDepositId, GENERIC_ZELLE_PAYMENT_METHOD_HASH, usdc(50));
    const signalReceipt = await signalTx.wait();
    const intentHash = signalReceipt.events?.find((event: any) => event.event === "IntentSignaled")?.args?.intentHash;
    const intent = await orchestrator.getIntent(intentHash);
    const paymentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp).mul(1000);
    const builtProof = await buildUnifiedPaymentProof({
      verifier: unifiedPaymentVerifierV2.address,
      witness,
      chainId,
      paymentPaymentMethod: GENERIC_ZELLE_PAYMENT_METHOD_HASH,
      paymentPayeeId: payeeId,
      paymentAmount: intent.amount,
      paymentCurrency: currency,
      paymentTimestamp,
      paymentPaymentId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("generic-zelle-payment")),
      attestationIntentHash: intentHash,
      attestationReleaseAmount: intent.amount,
      snapshotIntentHash: intentHash,
      snapshotIntentAmount: intent.amount,
      snapshotIntentPaymentMethod: GENERIC_ZELLE_PAYMENT_METHOD_HASH,
      snapshotIntentFiatCurrency: currency,
      snapshotIntentPayeeDetails: payeeId,
      snapshotIntentConversionRate: intent.conversionRate,
      snapshotIntentSignalTimestamp: intent.timestamp,
      snapshotIntentTimestampBuffer: ZERO,
      intentDepositId: genericDepositId,
      intentEscrow: escrow.address,
      intentTo: taker.address,
    });

    const takerBalanceBefore = await usdcToken.balanceOf(taker.address);
    await expect(
      orchestrator.fulfillIntent({
        paymentProof: builtProof.paymentProof,
        intentHash,
        verificationData: ZERO_BYTES,
        postIntentHookData: ZERO_BYTES,
      })
    ).to.emit(unifiedPaymentVerifierV2, "PaymentVerified");
    expect((await usdcToken.balanceOf(taker.address)).sub(takerBalanceBefore)).to.eq(usdc(50));

    const nonceBeforeSecondRun = await owner.wallet.getTransactionCount();
    await retireLegacyZelleVerifierRegistrations(
      hre,
      {
        paymentVerifierRegistry,
        legacyUnifiedPaymentVerifier,
        unifiedPaymentVerifierV2,
      },
      unifiedPaymentVerifierV2.address
    );
    expect(await owner.wallet.getTransactionCount()).to.eq(nonceBeforeSecondRun);
  });
});
