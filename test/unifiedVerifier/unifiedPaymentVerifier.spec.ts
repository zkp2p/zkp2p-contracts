import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import DeployHelper from "@utils/deploys";
import {
  Escrow,
  EscrowRegistry,
  IOrchestrator,
  NullifierRegistry,
  Orchestrator,
  OrchestratorRegistry,
  PaymentVerifierRegistry,
  PostIntentHookRegistry,
  RelayerRegistry,
  SimpleAttestationVerifier,
  UnifiedPaymentVerifier,
  USDCMock,
} from "@utils/contracts";
import {
  buildUnifiedPaymentProof,
  BuiltUnifiedPaymentProof,
  BuildPaymentProofOverrides,
  encodeUnifiedPaymentPayload,
} from "@utils/unifiedVerifierUtils";
import { Currency, calculateIntentHash } from "@utils/protocolUtils";
import { ONE_DAY_IN_SECONDS, ZERO, ADDRESS_ZERO } from "@utils/constants";
import { generateGatingServiceSignature } from "@utils/test/helpers";

const expect = getWaffleExpect();

const ZERO_BYTES = "0x";
const MAX_TIMESTAMP_BUFFER_MS = 48 * 60 * 60 * 1000;
const SAR_MARKER = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zkp2p.sar.v1"));


describe("UnifiedPaymentVerifier", () => {
  let owner: Account;
  let attacker: Account;
  let offRamper: Account;
  let intentOwner: Account;
  let receiver: Account;
  let gatingService: Account;
  let witness: Account;
  let feeRecipient: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let nullifierRegistry: NullifierRegistry;
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let attestationVerifier: SimpleAttestationVerifier;
  let verifier: UnifiedPaymentVerifier;

  let venmoPaymentMethodHash: BytesLike;
  let defaultPayeeId: BytesLike;
  let defaultPaymentId: BytesLike;
  let defaultCurrency: BytesLike;
  let defaultTimestamp: BigNumber;

  let chainId: number;
  let depositId: BigNumber;
  let intentHash: BytesLike;
  let intent: IOrchestrator.IntentStructOutput;

  let builtProof: BuiltUnifiedPaymentProof;

  beforeEach(async () => {
    [
      owner,
      attacker,
      offRamper,
      intentOwner,
      receiver,
      gatingService,
      witness,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(ethers.utils.parseUnits("1000000", 6), "USDC", "USDC");

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    nullifierRegistry = await deployer.deployNullifierRegistry();

    chainId = (await ethers.provider.getNetwork()).chainId;

    escrow = await deployer.deployEscrow(
      owner.address,
      BigNumber.from(chainId),
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
      ONE_DAY_IN_SECONDS,
    );

    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      BigNumber.from(chainId),
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,
      ZERO,
      feeRecipient.address,
    );

    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    await orchestratorRegistry.addOrchestrator(orchestrator.address);

    attestationVerifier = await deployer.deploySimpleAttestationVerifier(witness.address);

    verifier = await deployer.deployUnifiedPaymentVerifier(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address,
    );

    await nullifierRegistry.connect(owner.wallet).addWritePermission(verifier.address);

    venmoPaymentMethodHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await verifier.connect(owner.wallet).addPaymentMethod(venmoPaymentMethodHash);

    await paymentVerifierRegistry.addPaymentMethod(
      venmoPaymentMethodHash,
      verifier.address,
      [Currency.USD],
    );

    const depositAmount = ethers.utils.parseUnits("100", 6);
    await usdcToken.transfer(offRamper.address, depositAmount);
    await usdcToken.connect(offRamper.wallet).approve(escrow.address, depositAmount);

    defaultPayeeId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee-123"));
    const depositMinConversionRate = ethers.utils.parseEther("1");

    await escrow.connect(offRamper.wallet).createDeposit({
      token: usdcToken.address,
      amount: depositAmount,
      intentAmountRange: { min: depositAmount.div(2), max: depositAmount },
      paymentMethods: [venmoPaymentMethodHash],
      paymentMethodData: [{
        intentGatingService: gatingService.address,
        payeeDetails: defaultPayeeId,
        data: ZERO_BYTES,
      }],
      currencies: [[{ code: Currency.USD, minConversionRate: depositMinConversionRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    depositId = BigNumber.from(0);

    const currentCounter = await orchestrator.intentCounter();
    const conversionRate = ethers.utils.parseEther("1");
    const intentAmount = depositAmount.div(2);

    const signatureExpiration = BigNumber.from(
      (await ethers.provider.getBlock("latest")).timestamp,
    ).add(ONE_DAY_IN_SECONDS);
    const messageHash = ethers.utils.solidityKeccak256(
      [
        "address",
        "address",
        "uint256",
        "uint256",
        "address",
        "bytes32",
        "bytes32",
        "uint256",
        "uint256",
        "uint256",
      ],
      [
        orchestrator.address,
        escrow.address,
        depositId,
        intentAmount,
        receiver.address,
        venmoPaymentMethodHash,
        Currency.USD,
        conversionRate,
        signatureExpiration,
        chainId,
      ],
    );
    const gatingServiceSignature = await gatingService.wallet.signMessage(ethers.utils.arrayify(messageHash));

    await orchestrator.connect(intentOwner.wallet).signalIntent({
      escrow: escrow.address,
      depositId,
      amount: intentAmount,
      to: receiver.address,
      paymentMethod: venmoPaymentMethodHash,
      fiatCurrency: Currency.USD,
      conversionRate,
      referrer: ADDRESS_ZERO,
      referrerFee: ZERO,
      gatingServiceSignature,
      signatureExpiration,
      postIntentHook: ADDRESS_ZERO,
      data: ZERO_BYTES,
    });

    intentHash = calculateIntentHash(orchestrator.address, currentCounter);
    intent = await orchestrator.getIntent(intentHash);

    defaultTimestamp = BigNumber.from(intent.timestamp).mul(1000);
    defaultCurrency = Currency.USD;
    defaultPaymentId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payment-abc"));

    builtProof = await buildProof();
  });

  const buildProof = async (overrides: BuildPaymentProofOverrides = {}) => {
    return buildUnifiedPaymentProof({
      verifier: verifier.address,
      witness,
      chainId,
      paymentPaymentMethod: overrides.paymentPaymentMethod ?? venmoPaymentMethodHash,
      paymentPayeeId: overrides.paymentPayeeId ?? defaultPayeeId,
      paymentAmount: overrides.paymentAmount ?? intent.amount,
      paymentCurrency: overrides.paymentCurrency ?? defaultCurrency,
      paymentTimestamp: overrides.paymentTimestamp ?? defaultTimestamp,
      paymentPaymentId: overrides.paymentPaymentId ?? defaultPaymentId,
      attestationIntentHash: overrides.attestationIntentHash ?? intentHash,
      attestationReleaseAmount: overrides.attestationReleaseAmount ?? intent.amount,
      attestationMetadata: overrides.attestationMetadata ?? ZERO_BYTES,
      attestationSigner: overrides.attestationSigner,
      attestationData: overrides.attestationData,
      snapshotIntentHash: overrides.snapshotIntentHash ?? intentHash,
      snapshotIntentAmount: overrides.snapshotIntentAmount ?? intent.amount,
      snapshotIntentPaymentMethod: overrides.snapshotIntentPaymentMethod ?? venmoPaymentMethodHash,
      snapshotIntentFiatCurrency: overrides.snapshotIntentFiatCurrency ?? defaultCurrency,
      snapshotIntentPayeeDetails: overrides.snapshotIntentPayeeDetails ?? defaultPayeeId,
      snapshotIntentConversionRate: overrides.snapshotIntentConversionRate ?? intent.conversionRate,
      snapshotIntentSignalTimestamp: overrides.snapshotIntentSignalTimestamp ?? intent.timestamp,
      snapshotIntentTimestampBuffer: overrides.snapshotIntentTimestampBuffer ?? BigNumber.from(0),
      intentDepositId: overrides.intentDepositId ?? depositId,
      intentEscrow: overrides.intentEscrow ?? escrow.address,
      intentTo: overrides.intentTo ?? receiver.address,
    });
  };

  const buildVerificationDataForIntent = async (hash: BytesLike) => {
    const currentIntent = await orchestrator.getIntent(hash);
    const depositMethod = await escrow.getDepositPaymentMethodData(
      currentIntent.depositId,
      currentIntent.paymentMethod,
    );

    return ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "uint256", "bytes32"],
      [
        currentIntent.amount,
        currentIntent.conversionRate,
        currentIntent.timestamp,
        depositMethod.payeeDetails,
      ],
    );
  };

  async function verifierCallStatic(proof: BytesLike) {
    const verificationData = await buildVerificationDataForIntent(intentHash);
    const encodedCall = verifier.interface.encodeFunctionData("verifyPayment", [
      {
        intentHash,
        paymentProof: proof,
        data: verificationData,
      },
    ]);

    const raw = await ethers.provider.call({
      to: verifier.address,
      data: encodedCall,
      from: orchestrator.address,
    });

    const [result] = verifier.interface.decodeFunctionResult("verifyPayment", raw);
    return result as {
      success: boolean;
      intentHash: string;
      releaseAmount: BigNumber;
    };
  }

  describe("#verifyPayment via Orchestrator", () => {
    let subjectProof: BytesLike;

    beforeEach(() => {
      subjectProof = builtProof.paymentProof;
    });

    async function subject() {
      const verificationData = await buildVerificationDataForIntent(intentHash);
      return orchestrator.connect(attacker.wallet).fulfillIntent({
        paymentProof: subjectProof,
        intentHash,
        verificationData,
        postIntentHookData: ZERO_BYTES,
      });
    }

    async function subjectCallStatic() {
      const verificationData = await buildVerificationDataForIntent(intentHash);
      return orchestrator.connect(attacker.wallet).callStatic.fulfillIntent({
        paymentProof: subjectProof,
        intentHash,
        verificationData,
        postIntentHookData: ZERO_BYTES,
      });
    }

    it("verifies witness signature successfully", async () => {
      const result = await verifierCallStatic(subjectProof);

      expect(result.success).to.be.true;
      expect(result.intentHash).to.eq(intentHash);
      expect(result.releaseAmount).to.eq(builtProof.attestation.releaseAmount);
    });

    it("emits PaymentVerified event", async () => {
      await expect(subject())
        .to.emit(verifier, "PaymentVerified")
        .withArgs(
          intentHash,
          builtProof.paymentDetails.method,
          builtProof.paymentDetails.currency,
          builtProof.paymentDetails.amount,
          builtProof.paymentDetails.timestamp,
          builtProof.paymentDetails.paymentId,
          builtProof.paymentDetails.payeeId,
        );
    });

    it("emits PaymentReleaseClassified true for SAR metadata", async () => {
      builtProof = await buildProof({
        attestationMetadata: ethers.utils.defaultAbiCoder.encode(["bytes32"], [SAR_MARKER]),
      });
      subjectProof = builtProof.paymentProof;

      await expect(subject())
        .to.emit(verifier, "PaymentReleaseClassified")
        .withArgs(intentHash, true);
    });

    it("emits PaymentReleaseClassified false for empty metadata", async () => {
      await expect(subject())
        .to.emit(verifier, "PaymentReleaseClassified")
        .withArgs(intentHash, false);
    });

    it("should nullify the payment with correct collision-resistant nullifier", async () => {
      await subject();

      const expectedNullifier = ethers.utils.keccak256(
        ethers.utils.solidityPack(
          ["bytes32", "bytes32"],
          [builtProof.paymentDetails.method, builtProof.paymentDetails.paymentId],
        ),
      );

      expect(await nullifierRegistry.isNullified(expectedNullifier)).to.be.true;
    });

    describe("snapshot validation failures", () => {
      const setSnapshotOverride = async (overrides: BuildPaymentProofOverrides) => {
        builtProof = await buildProof(overrides);
        subjectProof = builtProof.paymentProof;
      };

      describe("when snapshot hash mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentHash: ethers.constants.HashZero });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot hash mismatch");
        });
      });

      describe("when snapshot amount mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentAmount: builtProof.intentSnapshot.amount.add(1) });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot amount mismatch");
        });
      });

      describe("when snapshot method mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentPaymentMethod: ethers.constants.HashZero });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot method mismatch");
        });
      });

      describe("when snapshot currency mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentFiatCurrency: ethers.constants.HashZero });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot currency mismatch");
        });
      });

      describe("when snapshot rate mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentConversionRate: builtProof.intentSnapshot.conversionRate.add(1) });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot rate mismatch");
        });
      });

      describe("when snapshot timestamp mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentSignalTimestamp: builtProof.intentSnapshot.signalTimestamp.add(1) });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot timestamp mismatch");
        });
      });

      describe("when snapshot timestamp buffer exceeds maximum", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentTimestampBuffer: BigNumber.from(MAX_TIMESTAMP_BUFFER_MS + 1) });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot timestamp buffer exceeds maximum");
        });
      });

      describe("when snapshot payee mismatches", () => {
        beforeEach(async () => {
          await setSnapshotOverride({ snapshotIntentPayeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("tampered")) });
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("UPV: Snapshot payee mismatch");
        });
      });
    });

    describe("when payment method is not registered", () => {
      beforeEach(async () => {
        builtProof = await buildProof({ paymentPaymentMethod: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("invalid")) });
        subjectProof = builtProof.paymentProof;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Invalid payment method");
      });
    });

    describe("when witness signature is not from the configured witness", () => {
      beforeEach(async () => {
        builtProof = await buildProof({ attestationSigner: attacker });
        subjectProof = builtProof.paymentProof;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: Not enough valid witness signatures",
        );
      });
    });

    describe("when attestation verifier returns false", () => {
      beforeEach(async () => {
        const failingFactory = await ethers.getContractFactory("FailingAttestationVerifier", owner.wallet);
        const failingVerifier = await failingFactory.deploy();
        await verifier.connect(owner.wallet).setAttestationVerifier(failingVerifier.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Invalid attestation");
      });
    });

    describe("when release amount exceeds intent amount", () => {
      beforeEach(async () => {
        builtProof = await buildProof({ attestationReleaseAmount: builtProof.attestation.releaseAmount.mul(2) });
        subjectProof = builtProof.paymentProof;
      });

      it("should cap release amount to intent amount", async () => {
        const result = await verifierCallStatic(subjectProof);
        expect(result.releaseAmount).to.eq(builtProof.intentSnapshot.amount);
      });
    });

    describe("when payment has already been verified", () => {
      let secondIntentHash: BytesLike;
      let secondIntent: IOrchestrator.IntentStructOutput;
      let secondProof: BytesLike;

      beforeEach(async () => {
        // Fulfil the first intent
        await subject();

        // Signal a new intent that reuses the same deposit context
        const secondIntentAmount = intent.amount;
        const signatureExpiration = BigNumber.from(
          (await ethers.provider.getBlock("latest")).timestamp,
        ).add(ONE_DAY_IN_SECONDS);
        const secondSignature = await generateGatingServiceSignature(
          gatingService,
          orchestrator.address,
          escrow.address,
          depositId,
          secondIntentAmount,
          receiver.address,
          venmoPaymentMethodHash,
          defaultCurrency.toString(),
          intent.conversionRate,
          chainId.toString(),
          signatureExpiration,
        )

        const counterBefore = await orchestrator.intentCounter();
        await orchestrator.connect(intentOwner.wallet).signalIntent({
          escrow: escrow.address,
          depositId,
          amount: secondIntentAmount,
          to: receiver.address,
          paymentMethod: venmoPaymentMethodHash,
          fiatCurrency: defaultCurrency,
          conversionRate: intent.conversionRate,
          referrer: ADDRESS_ZERO,
          referrerFee: ZERO,
          gatingServiceSignature: secondSignature,
          signatureExpiration,
          postIntentHook: ADDRESS_ZERO,
          data: ZERO_BYTES,
        });

        secondIntentHash = calculateIntentHash(orchestrator.address, counterBefore);
        secondIntent = await orchestrator.getIntent(secondIntentHash);

        const secondTimestampMs = BigNumber.from(secondIntent.timestamp).mul(1000);
        const proof = await buildUnifiedPaymentProof({
          verifier: verifier.address,
          witness,
          chainId,
          paymentPaymentMethod: venmoPaymentMethodHash,
          paymentPayeeId: defaultPayeeId,
          paymentAmount: secondIntent.amount,
          paymentCurrency: defaultCurrency,
          paymentTimestamp: secondTimestampMs,
          paymentPaymentId: builtProof.paymentDetails.paymentId,
          attestationIntentHash: secondIntentHash,
          attestationReleaseAmount: secondIntent.amount,
          snapshotIntentHash: secondIntentHash,
          snapshotIntentAmount: secondIntent.amount,
          snapshotIntentPaymentMethod: secondIntent.paymentMethod,
          snapshotIntentFiatCurrency: secondIntent.fiatCurrency,
          snapshotIntentPayeeDetails: defaultPayeeId,
          snapshotIntentConversionRate: secondIntent.conversionRate,
          snapshotIntentSignalTimestamp: secondIntent.timestamp,
          snapshotIntentTimestampBuffer: BigNumber.from(0),
          intentDepositId: depositId,
          intentEscrow: escrow.address,
          intentTo: receiver.address,
        });

        secondProof = proof.paymentProof;
      });

      it("should revert when reusing the payment proof", async () => {
        const verificationData = await buildVerificationDataForIntent(secondIntentHash);
        await expect(
          orchestrator.connect(attacker.wallet).fulfillIntent({
            paymentProof: secondProof,
            intentHash: secondIntentHash,
            verificationData,
            postIntentHookData: ZERO_BYTES,
          }),
        ).to.be.revertedWith("Nullifier has already been used");
      });
    });

    describe("when caller is not orchestrator", () => {
      it("should revert", async () => {
        await expect(
          verifier.connect(attacker.wallet).verifyPayment({
            intentHash,
            paymentProof: subjectProof,
            data: ZERO_BYTES,
          }),
        ).to.be.revertedWith("Only orchestrator can call");
      });
    });

    describe("when attestation data hash does not match provided data", () => {
      beforeEach(async () => {
        const tamperedDetails = {
          ...builtProof.paymentDetails,
          amount: builtProof.paymentDetails.amount.add(1),
        };
        const tamperedData = encodeUnifiedPaymentPayload(tamperedDetails, builtProof.intentSnapshot);

        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["tuple(bytes32,uint256,bytes32,bytes[],bytes,bytes)"],
          [[
            builtProof.attestation.intentHash,
            builtProof.attestation.releaseAmount,
            builtProof.attestation.dataHash,
            builtProof.attestation.signatures,
            tamperedData,
            builtProof.attestation.metadata,
          ]],
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Data hash mismatch");
      });
    });

    describe("when the signature digest is tampered", () => {
      beforeEach(async () => {
        subjectProof = ethers.utils.defaultAbiCoder.encode(
          ["tuple(bytes32,uint256,bytes32,bytes[],bytes,bytes)"],
          [[
            builtProof.attestation.intentHash,
            builtProof.attestation.releaseAmount.add(1),
            builtProof.attestation.dataHash,
            builtProof.attestation.signatures,
            builtProof.attestation.data,
            builtProof.attestation.metadata,
          ]],
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: Not enough valid witness signatures",
        );
      });
    });
  });
});
