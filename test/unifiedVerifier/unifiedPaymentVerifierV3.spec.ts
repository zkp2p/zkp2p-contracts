import "module-alias/register";

import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

import { getAccounts } from "@utils/test/index";
import { buildUnifiedPaymentProof, BuildPaymentProofOverrides } from "@utils/unifiedVerifierUtils";
import { Currency } from "@utils/protocolUtils";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ZERO } from "@utils/constants";

const METHOD = ethers.utils.id("venmo");
const OTHER_METHOD = ethers.utils.id("paypal");
const PAYEE = ethers.utils.id("binding-payee");
const EMPTY_BYTES = "0x";

describe("UnifiedPaymentVerifierV3 payment-to-intent bindings", () => {
  async function fixture() {
    const [owner, maker, taker, witness, fulfiller] = await getAccounts();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const token = await (await ethers.getContractFactory("USDCMock", owner.wallet))
      .deploy(ethers.utils.parseUnits("1000000", 6), "USDC", "USDC");
    const escrowRegistry = await (await ethers.getContractFactory("EscrowRegistry", owner.wallet)).deploy();
    const orchestratorRegistry = await (await ethers.getContractFactory("OrchestratorRegistry", owner.wallet)).deploy();
    const paymentVerifierRegistry = await (await ethers.getContractFactory("PaymentVerifierRegistry", owner.wallet)).deploy();
    const relayerRegistry = await (await ethers.getContractFactory("RelayerRegistry", owner.wallet)).deploy();
    const legacyNullifierRegistry = await (await ethers.getContractFactory("NullifierRegistry", owner.wallet)).deploy();
    const nullifierRegistry = await (await ethers.getContractFactory("NullifierRegistryV2", owner.wallet))
      .deploy(legacyNullifierRegistry.address);
    const attestationVerifier = await (await ethers.getContractFactory("SimpleAttestationVerifier", owner.wallet))
      .deploy(witness.address);
    const verifier = await (await ethers.getContractFactory("UnifiedPaymentVerifierV3", owner.wallet)).deploy(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address,
    );

    const escrow = await (await ethers.getContractFactory("EscrowV2", owner.wallet)).deploy(
      owner.address,
      chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      0,
      20,
      3600,
    );
    const orchestratorV2 = await (await ethers.getContractFactory("OrchestratorV2", owner.wallet)).deploy(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      0,
      owner.address,
    );
    const boundedCall = await (await ethers.getContractFactory("BoundedCall", owner.wallet)).deploy();
    const executor = await (await ethers.getContractFactory("PostIntentHookExecutor", owner.wallet)).deploy();
    const riskSettlementExecutor = await (await ethers.getContractFactory("RiskSettlementExecutor", {
      signer: owner.wallet,
      libraries: { BoundedCall: boundedCall.address },
    })).deploy();
    const feeSettlementLib = await (await ethers.getContractFactory("FeeSettlementLib", {
      signer: owner.wallet,
      libraries: {
        PostIntentHookExecutor: executor.address,
        RiskSettlementExecutor: riskSettlementExecutor.address,
      },
    })).deploy();
    const orchestratorV3 = await (await ethers.getContractFactory("OrchestratorV3", {
      signer: owner.wallet,
      libraries: {
        BoundedCall: boundedCall.address,
        FeeSettlementLib: feeSettlementLib.address,
      },
    })).deploy(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      0,
      owner.address,
      2_000_000,
    );

    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestratorV2.address);
    await orchestratorRegistry.addOrchestrator(orchestratorV3.address);
    await orchestratorV2.setAllowMultipleIntents(true);
    await nullifierRegistry.addWritePermission(verifier.address);
    await legacyNullifierRegistry.addWritePermission(owner.address);
    await verifier.addPaymentMethod(METHOD);
    await verifier.addPaymentMethod(OTHER_METHOD);
    await paymentVerifierRegistry.addPaymentMethod(METHOD, verifier.address, [Currency.USD]);

    await token.transfer(maker.address, ethers.utils.parseUnits("1000", 6));
    await token.connect(maker.wallet).approve(escrow.address, ethers.constants.MaxUint256);
    await escrow.connect(maker.wallet).createDeposit({
      token: token.address,
      amount: ethers.utils.parseUnits("1000", 6),
      intentAmountRange: { min: 1, max: ethers.utils.parseUnits("500", 6) },
      paymentMethods: [METHOD],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: PAYEE, data: EMPTY_BYTES }],
      currencies: [[{
        code: Currency.USD,
        minConversionRate: ethers.utils.parseEther("1"),
        oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
      }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: true,
    });

    return {
      owner, maker, taker, witness, fulfiller, chainId, token, escrow, orchestratorV2, orchestratorV3,
      orchestratorRegistry, paymentVerifierRegistry, legacyNullifierRegistry, nullifierRegistry,
      attestationVerifier, verifier,
    };
  }

  async function signal(f: Awaited<ReturnType<typeof fixture>>, orchestrator: Contract) {
    const tx = await orchestrator.connect(f.taker.wallet).signalIntent({
      escrow: f.escrow.address,
      depositId: ZERO,
      amount: ethers.utils.parseUnits("50", 6),
      to: f.taker.address,
      paymentMethod: METHOD,
      fiatCurrency: Currency.USD,
      conversionRate: ethers.utils.parseEther("1"),
      referralFees: [],
      gatingServiceSignature: EMPTY_BYTES,
      signatureExpiration: ZERO,
      postIntentHook: ADDRESS_ZERO,
      preIntentHookData: EMPTY_BYTES,
      data: EMPTY_BYTES,
    });
    const receipt = await tx.wait();
    return receipt.events?.find((event: any) => event.event === "IntentSignaled")?.args?.intentHash as string;
  }

  async function proof(
    f: Awaited<ReturnType<typeof fixture>>,
    orchestrator: Contract,
    intentHash: string,
    paymentId: string,
    overrides: BuildPaymentProofOverrides = {},
    verifier = f.verifier,
  ) {
    const intent = await orchestrator.getIntent(intentHash);
    return buildUnifiedPaymentProof({
      verifier: verifier.address,
      witness: f.witness,
      chainId: f.chainId,
      paymentPaymentMethod: overrides.paymentPaymentMethod ?? METHOD,
      paymentPayeeId: PAYEE,
      paymentAmount: overrides.paymentAmount ?? intent.amount,
      paymentCurrency: overrides.paymentCurrency ?? Currency.USD,
      paymentTimestamp: BigNumber.from(intent.timestamp).mul(1000),
      paymentPaymentId: overrides.paymentPaymentId ?? paymentId,
      attestationSigner: overrides.attestationSigner,
      attestationIntentHash: overrides.attestationIntentHash ?? intentHash,
      attestationReleaseAmount: overrides.attestationReleaseAmount ?? intent.amount,
      attestationDataHash: overrides.attestationDataHash,
      attestationData: overrides.attestationData,
      snapshotIntentHash: overrides.snapshotIntentHash ?? intentHash,
      snapshotIntentAmount: overrides.snapshotIntentAmount ?? intent.amount,
      snapshotIntentPaymentMethod: overrides.snapshotIntentPaymentMethod ?? METHOD,
      snapshotIntentFiatCurrency: overrides.snapshotIntentFiatCurrency ?? Currency.USD,
      snapshotIntentPayeeDetails: overrides.snapshotIntentPayeeDetails ?? PAYEE,
      snapshotIntentConversionRate: overrides.snapshotIntentConversionRate ?? intent.conversionRate,
      snapshotIntentSignalTimestamp: overrides.snapshotIntentSignalTimestamp ?? intent.timestamp,
      snapshotIntentTimestampBuffer: overrides.snapshotIntentTimestampBuffer ?? ZERO,
      intentDepositId: ZERO,
      intentEscrow: f.escrow.address,
      intentTo: f.taker.address,
    });
  }

  async function fulfill(orchestrator: Contract, fulfiller: any, intentHash: string, paymentProof: any) {
    return orchestrator.connect(fulfiller.wallet).fulfillIntent({
      paymentProof,
      intentHash,
      verificationData: EMPTY_BYTES,
      postIntentHookData: EMPTY_BYTES,
    });
  }

  it("serves Orchestrator V2 and V3 through the existing three-field verifier ABI", async () => {
    const f = await loadFixture(fixture);
    const abiResult = f.verifier.interface.getFunction("verifyPayment").outputs?.[0].components;
    expect(abiResult?.map((component: any) => component.name)).to.deep.eq(["success", "intentHash", "releaseAmount"]);

    for (const [orchestrator, label] of [[f.orchestratorV2, "v2"], [f.orchestratorV3, "v3"]] as const) {
      const intentHash = await signal(f, orchestrator);
      const paymentId = ethers.utils.id(`payment-${label}`);
      const built = await proof(f, orchestrator, intentHash, paymentId);
      await expect(fulfill(orchestrator, f.fulfiller, intentHash, built.paymentProof))
        .to.emit(f.verifier, "PaymentVerified")
        .withArgs(intentHash, METHOD, Currency.USD, built.paymentDetails.amount,
          built.paymentDetails.timestamp, paymentId, PAYEE);
      const nullifier = ethers.utils.solidityKeccak256(["bytes32", "bytes32"], [METHOD, paymentId]);
      expect(await f.nullifierRegistry.intentHashByNullifier(nullifier)).to.eq(intentHash);
      expect(await f.nullifierRegistry.nullifierByIntentHash(intentHash)).to.eq(nullifier);
    }
  });

  it("rejects predecessor replay and replay between live orchestrators", async () => {
    const f = await loadFixture(fixture);
    const predecessorPaymentId = ethers.utils.id("predecessor-payment");
    const predecessorNullifier = ethers.utils.solidityKeccak256(
      ["bytes32", "bytes32"], [METHOD, predecessorPaymentId],
    );
    await f.legacyNullifierRegistry.addNullifier(predecessorNullifier);
    const oldIntent = await signal(f, f.orchestratorV2);
    const oldProof = await proof(f, f.orchestratorV2, oldIntent, predecessorPaymentId);
    await expect(fulfill(f.orchestratorV2, f.fulfiller, oldIntent, oldProof.paymentProof))
      .to.be.revertedWith("Nullifier has already been used");

    const sharedPaymentId = ethers.utils.id("shared-live-payment");
    const firstIntent = await signal(f, f.orchestratorV2);
    await fulfill(f.orchestratorV2, f.fulfiller, firstIntent,
      (await proof(f, f.orchestratorV2, firstIntent, sharedPaymentId)).paymentProof);
    const secondIntent = await signal(f, f.orchestratorV3);
    await expect(fulfill(f.orchestratorV3, f.fulfiller, secondIntent,
      (await proof(f, f.orchestratorV3, secondIntent, sharedPaymentId)).paymentProof))
      .to.be.revertedWith("Nullifier has already been used");
  });

  it("rejects an attested method different from the intent and zero payment fields", async () => {
    const f = await loadFixture(fixture);
    const cases: Array<[BuildPaymentProofOverrides, string]> = [
      [{ paymentPaymentMethod: OTHER_METHOD }, "UPV: Payment method mismatch"],
      [{ paymentPaymentId: ethers.constants.HashZero }, "UPV: Invalid payment ID"],
      [{ paymentAmount: BigNumber.from(0) }, "UPV: Invalid payment amount"],
      [{ paymentCurrency: ethers.constants.HashZero }, "UPV: Invalid payment currency"],
    ];
    for (const [overrides, message] of cases) {
      const intentHash = await signal(f, f.orchestratorV2);
      const built = await proof(f, f.orchestratorV2, intentHash, ethers.utils.id(message), overrides);
      await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, built.paymentProof)).to.be.revertedWith(message);
    }
  });

  it("rejects an attestation bound to a different intent before writing its nullifier", async () => {
    const f = await loadFixture(fixture);
    const intentHash = await signal(f, f.orchestratorV2);
    const otherIntentHash = ethers.utils.id("other-intent");
    const paymentId = ethers.utils.id("wrong-intent-attestation");
    const built = await proof(f, f.orchestratorV2, intentHash, paymentId, {
      attestationIntentHash: otherIntentHash,
    });

    await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, built.paymentProof))
      .to.be.revertedWith("UPV: Attestation hash mismatch");
    const nullifier = ethers.utils.solidityKeccak256(["bytes32", "bytes32"], [METHOD, paymentId]);
    expect(await f.nullifierRegistry.isNullified(nullifier)).to.eq(false);
  });

  it("rejects a zero attested release before writing its nullifier", async () => {
    const f = await loadFixture(fixture);
    const intentHash = await signal(f, f.orchestratorV3);
    const paymentId = ethers.utils.id("zero-release-attestation");
    const built = await proof(f, f.orchestratorV3, intentHash, paymentId, {
      attestationReleaseAmount: BigNumber.from(0),
    });

    await expect(fulfill(f.orchestratorV3, f.fulfiller, intentHash, built.paymentProof))
      .to.be.revertedWith("UPV: Invalid release amount");
    const nullifier = ethers.utils.solidityKeccak256(["bytes32", "bytes32"], [METHOD, paymentId]);
    expect(await f.nullifierRegistry.isNullified(nullifier)).to.eq(false);
  });

  it("accepts only a distinct deployed attestation verifier", async () => {
    const f = await loadFixture(fixture);
    const replacement = await (await ethers.getContractFactory("SimpleAttestationVerifier", f.owner.wallet))
      .deploy(f.fulfiller.address);

    await expect(f.verifier.connect(f.taker.wallet).setAttestationVerifier(replacement.address))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(f.verifier.setAttestationVerifier(ethers.constants.AddressZero))
      .to.be.revertedWith("UPV: Invalid attestation verifier");
    await expect(f.verifier.setAttestationVerifier(f.taker.address))
      .to.be.revertedWith("UPV: Invalid attestation verifier");
    await expect(f.verifier.setAttestationVerifier(f.attestationVerifier.address))
      .to.be.revertedWith("UPV: Same verifier");
    await expect(f.verifier.setAttestationVerifier(replacement.address))
      .to.emit(f.verifier, "AttestationVerifierUpdated")
      .withArgs(f.attestationVerifier.address, replacement.address);
    expect(await f.verifier.attestationVerifier()).to.eq(replacement.address);
  });

  it("fully enforces constructor and payment-method governance", async () => {
    const f = await loadFixture(fixture);
    const factory = await ethers.getContractFactory("UnifiedPaymentVerifierV3", f.owner.wallet);

    await expect(factory.deploy(f.taker.address, f.nullifierRegistry.address, f.attestationVerifier.address))
      .to.be.revertedWith("UPV: Invalid orchestrator registry");
    await expect(factory.deploy(f.orchestratorRegistry.address, f.taker.address, f.attestationVerifier.address))
      .to.be.revertedWith("UPV: Invalid nullifier registry");
    await expect(factory.deploy(f.orchestratorRegistry.address, f.nullifierRegistry.address, f.taker.address))
      .to.be.revertedWith("UPV: Invalid attestation verifier");

    expect(await f.verifier.getPaymentMethods()).to.deep.eq([METHOD, OTHER_METHOD]);
    await expect(f.verifier.connect(f.taker.wallet).addPaymentMethod(ethers.utils.id("unauthorized")))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(f.verifier.addPaymentMethod(METHOD)).to.be.revertedWith("UPV: Payment method already exists");
    await expect(f.verifier.removePaymentMethod(OTHER_METHOD))
      .to.emit(f.verifier, "PaymentMethodRemoved").withArgs(OTHER_METHOD);
    expect(await f.verifier.isPaymentMethod(OTHER_METHOD)).to.eq(false);
    await expect(f.verifier.removePaymentMethod(OTHER_METHOD)).to.be.revertedWith("UPV: Payment method does not exist");
    await expect(f.verifier.connect(f.taker.wallet).removePaymentMethod(METHOD))
      .to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("rejects unauthorized callers, unsupported methods, invalid signatures, and tampered data", async () => {
    const f = await loadFixture(fixture);
    const intentHash = await signal(f, f.orchestratorV2);
    const paymentId = ethers.utils.id("invalid-proof-cases");
    const valid = await proof(f, f.orchestratorV2, intentHash, paymentId);

    await expect(f.verifier.connect(f.taker.wallet).verifyPayment({
      intentHash, paymentProof: valid.paymentProof, data: EMPTY_BYTES,
    }), "unauthorized caller").to.be.revertedWith("Only orchestrator can call");

    const unsupported = await proof(f, f.orchestratorV2, intentHash, paymentId, {
      paymentPaymentMethod: ethers.utils.id("unsupported-method"),
      snapshotIntentPaymentMethod: METHOD,
    });
    await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, unsupported.paymentProof), "unsupported method")
      .to.be.revertedWith("UPV: Invalid payment method");

    const badSigner = await proof(f, f.orchestratorV2, intentHash, paymentId, {
      attestationSigner: f.taker,
    });
    await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, badSigner.paymentProof), "bad signer")
      .to.be.revertedWith("ThresholdSigVerifierUtils: Not enough valid witness signatures");

    const tamperedData = ethers.utils.hexConcat([valid.attestation.data as string, "0x00"]);
    const tampered = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32,uint256,bytes32,bytes[],bytes,bytes)"],
      [[valid.attestation.intentHash, valid.attestation.releaseAmount, valid.attestation.dataHash,
        valid.attestation.signatures, tamperedData, valid.attestation.metadata]],
    );
    await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, tampered), "tampered data")
      .to.be.revertedWith("UPV: Data hash mismatch");

    const failingVerifier = await (await ethers.getContractFactory("FailingAttestationVerifier", f.owner.wallet)).deploy();
    await f.verifier.setAttestationVerifier(failingVerifier.address);
    await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, valid.paymentProof), "false verifier")
      .to.be.revertedWith("UPV: Invalid attestation");
  });

  it("validates every attested intent snapshot field and the timestamp-buffer ceiling", async () => {
    const f = await loadFixture(fixture);
    const cases: Array<[BuildPaymentProofOverrides, string]> = [
      [{ snapshotIntentHash: ethers.constants.HashZero }, "UPV: Snapshot hash mismatch"],
      [{ snapshotIntentPayeeDetails: ethers.utils.id("wrong-payee") }, "UPV: Snapshot payee mismatch"],
      [{ snapshotIntentAmount: BigNumber.from(1) }, "UPV: Snapshot amount mismatch"],
      [{ paymentPaymentMethod: OTHER_METHOD, snapshotIntentPaymentMethod: OTHER_METHOD }, "UPV: Snapshot method mismatch"],
      [{ snapshotIntentFiatCurrency: ethers.utils.id("EUR") }, "UPV: Snapshot currency mismatch"],
      [{ snapshotIntentConversionRate: BigNumber.from(1) }, "UPV: Snapshot rate mismatch"],
      [{ snapshotIntentSignalTimestamp: BigNumber.from(1) }, "UPV: Snapshot timestamp mismatch"],
      [{ snapshotIntentTimestampBuffer: BigNumber.from(48 * 60 * 60 * 1000 + 1) },
        "UPV: Snapshot timestamp buffer exceeds maximum"],
    ];

    for (const [overrides, message] of cases) {
      const intentHash = await signal(f, f.orchestratorV2);
      const built = await proof(f, f.orchestratorV2, intentHash, ethers.utils.id(message), overrides);
      await expect(fulfill(f.orchestratorV2, f.fulfiller, intentHash, built.paymentProof), message)
        .to.be.revertedWith(message);
    }
  });

  it("caps overpayment and exercises the legacy orchestrator snapshot shape", async () => {
    const f = await loadFixture(fixture);
    const caller = await (await ethers.getContractFactory("UnifiedPaymentVerifierV3CallerHarness", f.owner.wallet)).deploy();
    await f.orchestratorRegistry.addOrchestrator(caller.address);
    const intentHash = ethers.utils.id("legacy-shape-intent");
    const amount = ethers.utils.parseUnits("50", 6);
    const timestamp = await ethers.provider.getBlock("latest").then((block) => block.timestamp);
    await caller.setIntent(intentHash, {
      owner: f.taker.address, to: f.taker.address, escrow: f.escrow.address, depositId: 0,
      amount, timestamp, paymentMethod: METHOD, fiatCurrency: Currency.USD,
      conversionRate: ethers.utils.parseEther("1"), payeeId: PAYEE,
      referrer: ethers.constants.AddressZero, referrerFee: 0,
      postIntentHook: ethers.constants.AddressZero, data: EMPTY_BYTES,
    });
    const paymentId = ethers.utils.id("legacy-shape-payment");
    const built = await buildUnifiedPaymentProof({
      verifier: f.verifier.address, witness: f.witness, chainId: f.chainId,
      paymentPaymentMethod: METHOD, paymentPayeeId: PAYEE, paymentAmount: amount,
      paymentCurrency: Currency.USD, paymentTimestamp: BigNumber.from(timestamp).mul(1000),
      paymentPaymentId: paymentId, attestationIntentHash: intentHash,
      attestationReleaseAmount: amount.mul(2), snapshotIntentHash: intentHash,
      snapshotIntentAmount: amount, snapshotIntentPaymentMethod: METHOD,
      snapshotIntentFiatCurrency: Currency.USD, snapshotIntentPayeeDetails: PAYEE,
      snapshotIntentConversionRate: ethers.utils.parseEther("1"),
      snapshotIntentSignalTimestamp: BigNumber.from(timestamp), snapshotIntentTimestampBuffer: ZERO,
    });
    const result = await caller.callStatic.verifyPayment(f.verifier.address, {
      intentHash, paymentProof: built.paymentProof, data: EMPTY_BYTES,
    });
    expect(result.releaseAmount).to.eq(amount);
    await caller.verifyPayment(f.verifier.address, { intentHash, paymentProof: built.paymentProof, data: EMPTY_BYTES });
  });

  it("survives verifier rotation while the retired verifier loses write authority", async () => {
    const f = await loadFixture(fixture);
    const replacement = await (await ethers.getContractFactory("UnifiedPaymentVerifierV3", f.owner.wallet)).deploy(
      f.orchestratorRegistry.address,
      f.nullifierRegistry.address,
      f.attestationVerifier.address,
    );
    await replacement.addPaymentMethod(METHOD);
    await f.nullifierRegistry.addWritePermission(replacement.address);
    await f.paymentVerifierRegistry.removePaymentMethod(METHOD);
    await f.paymentVerifierRegistry.addPaymentMethod(METHOD, replacement.address, [Currency.USD]);
    await f.nullifierRegistry.removeWritePermission(f.verifier.address);

    const intentHash = await signal(f, f.orchestratorV3);
    const paymentId = ethers.utils.id("rotated-payment");
    const built = await proof(f, f.orchestratorV3, intentHash, paymentId, {}, replacement);
    await fulfill(f.orchestratorV3, f.fulfiller, intentHash, built.paymentProof);
    const nullifier = ethers.utils.solidityKeccak256(["bytes32", "bytes32"], [METHOD, paymentId]);
    expect(await f.nullifierRegistry.intentHashByNullifier(nullifier)).to.eq(intentHash);
    expect(await f.nullifierRegistry.isWriter(f.verifier.address)).to.eq(false);
  });
});
