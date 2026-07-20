import "module-alias/register";

import { BigNumber, BytesLike } from "ethers";
import * as fs from "fs";
import * as hre from "hardhat";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ZERO } from "@utils/constants";
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
  LEGACY_ZELLE_PAYMENT_METHODS,
  removeLegacyZelleVerifierRegistrations,
} from "../../deploy/27_remove_legacy_zelle_payment_methods";
import { safeBatchCollector } from "../../deployments/safeBatchCollector";

const { ethers } = hre;
const expect = getWaffleExpect();
const ZERO_BYTES = "0x";

describe("Remove legacy Zelle payment methods", () => {
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

    const attestationVerifier: SimpleAttestationVerifier =
      await deployer.deploySimpleAttestationVerifier(witness.address);
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

    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
      await legacyUnifiedPaymentVerifier.addPaymentMethod(hash);
      await unifiedPaymentVerifierV2.addPaymentMethod(hash);
      await paymentVerifierRegistry.addPaymentMethod(hash, unifiedPaymentVerifierV2.address, [currency]);
    }

    await usdcToken.transfer(maker.address, usdc(2_000));
    await usdcToken.connect(maker.wallet).approve(escrow.address, usdc(2_000));
    legacyDepositIds = [];
    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
      legacyDepositIds.push(await createDeposit(hash, usdc(300)));
    }
  });

  it("removes all legacy registrations, preserves withdrawal, and keeps generic Zelle functional", async () => {
    const migrationStartBlock = await ethers.provider.getBlockNumber();
    const nonceBefore = await owner.wallet.getTransactionCount();
    await removeLegacyZelleVerifierRegistrations(
      hre,
      { paymentVerifierRegistry, legacyUnifiedPaymentVerifier, unifiedPaymentVerifierV2 },
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
    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
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

    for (const [index, { hash }] of LEGACY_ZELLE_PAYMENT_METHODS.entries()) {
      const existingDeposit = await escrow.getDeposit(legacyDepositIds[index]);
      expect(existingDeposit.remainingDeposits).to.eq(usdc(300));
      await expect(createDeposit(hash, usdc(100))).to.be.revertedWithCustomError(
        escrow,
        "PaymentMethodNotWhitelisted"
      );
      await expect(signalIntent(legacyDepositIds[index], hash, usdc(50))).to.be.revertedWithCustomError(
        orchestrator,
        "PaymentMethodDoesNotExist"
      );
    }

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

    await expect(orchestrator.fulfillIntent({
      paymentProof: builtProof.paymentProof,
      intentHash,
      verificationData: ZERO_BYTES,
      postIntentHookData: ZERO_BYTES,
    })).to.emit(unifiedPaymentVerifierV2, "PaymentVerified");

    const nonceBeforeSecondRun = await owner.wallet.getTransactionCount();
    await removeLegacyZelleVerifierRegistrations(
      hre,
      { paymentVerifierRegistry, legacyUnifiedPaymentVerifier, unifiedPaymentVerifierV2 },
      unifiedPaymentVerifierV2.address
    );
    expect(await owner.wallet.getTransactionCount()).to.eq(nonceBeforeSecondRun);
  });

  it("queues the exact registry-first removal batch when the contracts are Safe-owned", async () => {
    const safeOwner = ethers.Wallet.createRandom().address;
    const unnamedAccounts = (await hre.getUnnamedAccounts()).map((account) => account.toLowerCase());
    expect(unnamedAccounts).to.not.include(safeOwner.toLowerCase());
    expect(safeBatchCollector.count()).to.eq(0);

    await paymentVerifierRegistry.transferOwnership(safeOwner);
    await legacyUnifiedPaymentVerifier.transferOwnership(safeOwner);
    await unifiedPaymentVerifierV2.transferOwnership(safeOwner);

    await removeLegacyZelleVerifierRegistrations(
      hre,
      { paymentVerifierRegistry, legacyUnifiedPaymentVerifier, unifiedPaymentVerifierV2 },
      unifiedPaymentVerifierV2.address
    );

    expect(safeBatchCollector.count()).to.eq(9);

    // The following risk-settlement cutover script observes unchanged on-chain state when these
    // removals are Safe-owned and may request the same registry calls again. The shared collector
    // must retain only one copy so the atomic Safe batch cannot revert on the second removal.
    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
      safeBatchCollector.add(
        paymentVerifierRegistry.address,
        paymentVerifierRegistry.interface.encodeFunctionData("removePaymentMethod", [hash]),
      );
    }
    expect(safeBatchCollector.count()).to.eq(9);

    const expectedTransactions = [
      ...LEGACY_ZELLE_PAYMENT_METHODS.map(({ hash }) => ({
        to: paymentVerifierRegistry.address,
        data: paymentVerifierRegistry.interface.encodeFunctionData("removePaymentMethod", [hash]),
      })),
      ...LEGACY_ZELLE_PAYMENT_METHODS.map(({ hash }) => ({
        to: legacyUnifiedPaymentVerifier.address,
        data: legacyUnifiedPaymentVerifier.interface.encodeFunctionData("removePaymentMethod", [hash]),
      })),
      ...LEGACY_ZELLE_PAYMENT_METHODS.map(({ hash }) => ({
        to: unifiedPaymentVerifierV2.address,
        data: unifiedPaymentVerifierV2.interface.encodeFunctionData("removePaymentMethod", [hash]),
      })),
    ].map(({ to, data }) => ({
      to,
      value: "0",
      data,
      contractMethod: null,
      contractInputsValues: null,
    }));

    const batchFile = safeBatchCollector.writeBatchFile("hardhat", String(chainId), safeOwner);
    try {
      const batch = JSON.parse(fs.readFileSync(batchFile, "utf8"));
      expect(batch.chainId).to.eq(String(chainId));
      expect(batch.meta.createdFromSafeAddress).to.eq(safeOwner);
      expect(batch.transactions).to.deep.eq(expectedTransactions);
    } finally {
      fs.unlinkSync(batchFile);
    }

    const legacyPaymentMethods = await legacyUnifiedPaymentVerifier.getPaymentMethods();
    const v2PaymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
      expect(await paymentVerifierRegistry.isPaymentMethod(hash)).to.be.true;
      expect(legacyPaymentMethods).to.include(hash);
      expect(v2PaymentMethods).to.include(hash);
    }
    expect(await paymentVerifierRegistry.isPaymentMethod(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.be.true;
    expect(await paymentVerifierRegistry.getVerifier(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.eq(
      unifiedPaymentVerifierV2.address
    );
    expect(v2PaymentMethods).to.include(GENERIC_ZELLE_PAYMENT_METHOD_HASH);
  });
});

describe("Deployed Zelle payment method state", () => {
  const network = hre.deployments.getNetworkName();

  function getDeployedContractAddress(contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  it("leaves generic Zelle active and every legacy hash unsupported after the full deploy sequence", async () => {
    const paymentVerifierRegistry = await ethers.getContractAt(
      "PaymentVerifierRegistry",
      getDeployedContractAddress("PaymentVerifierRegistry")
    );
    const legacyUnifiedPaymentVerifier = await ethers.getContractAt(
      "UnifiedPaymentVerifier",
      getDeployedContractAddress("UnifiedPaymentVerifier")
    );
    const unifiedPaymentVerifierV2 = await ethers.getContractAt(
      "UnifiedPaymentVerifier",
      getDeployedContractAddress("UnifiedPaymentVerifierV2")
    );

    const legacyPaymentMethods = await legacyUnifiedPaymentVerifier.getPaymentMethods();
    const v2PaymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();
    for (const { hash } of LEGACY_ZELLE_PAYMENT_METHODS) {
      expect(await paymentVerifierRegistry.isPaymentMethod(hash)).to.be.false;
      expect(await paymentVerifierRegistry.getVerifier(hash)).to.eq(ADDRESS_ZERO);
      expect(legacyPaymentMethods).to.not.include(hash);
      expect(v2PaymentMethods).to.not.include(hash);
    }

    expect(await paymentVerifierRegistry.isPaymentMethod(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.be.true;
    expect(await paymentVerifierRegistry.getVerifier(GENERIC_ZELLE_PAYMENT_METHOD_HASH)).to.eq(
      getDeployedContractAddress("UnifiedPaymentVerifierV3")
    );
    expect(v2PaymentMethods).to.include(GENERIC_ZELLE_PAYMENT_METHOD_HASH);
  });
});
