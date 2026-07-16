import "module-alias/register";

import { expect } from "chai";
import { ethers } from "hardhat";

import {
  assertChargebackE2ENetwork,
  CHARGEBACK_E2E_DEPLOYER,
  isolatedWitnessConfig,
} from "../../deploy/28_deploy_chargeback_e2e_staging";
import {
  buildChargebackAttestation,
  buildPaymentProof,
  deriveRunIdentifiers,
} from "../../scripts/chargeback-staging-e2e";

describe("Chargeback E2E staging deployment", () => {
  const livePaymentWitnesses = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ];
  const paymentWitnesses = [
    "0x0000000000000000000000000000000000000011",
    "0x0000000000000000000000000000000000000012",
    "0x0000000000000000000000000000000000000013",
  ];
  const chargebackWitnesses = [
    "0x0000000000000000000000000000000000000021",
    "0x0000000000000000000000000000000000000022",
    "0x0000000000000000000000000000000000000023",
  ];

  it("requires two separate 2-of-3 witness domains", () => {
    const config = isolatedWitnessConfig(
      paymentWitnesses.join(","),
      chargebackWitnesses.join(","),
      livePaymentWitnesses,
    );
    expect(config.paymentWitnesses).to.have.members(paymentWitnesses);
    expect(config.paymentThreshold).to.eq(2);
    expect(config.chargebackWitnesses).to.have.members(chargebackWitnesses);
    expect(config.chargebackThreshold).to.eq(2);
  });

  it("rejects overlap between payment and chargeback credentials", () => {
    expect(() => isolatedWitnessConfig(
      paymentWitnesses.join(","),
      [paymentWitnesses[0], chargebackWitnesses[1], chargebackWitnesses[2]].join(","),
      livePaymentWitnesses,
    )).to.throw("payment and chargeback witness sets must be disjoint");
  });

  it("rejects overlap with the existing payment witness set", () => {
    expect(() => isolatedWitnessConfig(
      [livePaymentWitnesses[0], paymentWitnesses[1], paymentWitnesses[2]].join(","),
      chargebackWitnesses.join(","),
      livePaymentWitnesses,
    )).to.throw("isolated payment witnesses must be disjoint from the live payment witness set");
  });

  it("rejects incomplete and duplicate witness sets", () => {
    expect(() => isolatedWitnessConfig(
      paymentWitnesses.slice(0, 2).join(","),
      chargebackWitnesses.join(","),
      livePaymentWitnesses,
    )).to.throw("requires exactly 3 public witness addresses");
    expect(() => isolatedWitnessConfig(
      [paymentWitnesses[0], paymentWitnesses[0], paymentWitnesses[2]].join(","),
      chargebackWitnesses.join(","),
      livePaymentWitnesses,
    )).to.throw("witnesses must be unique");
  });

  it("hard-gates the deployment to Base staging and the 0x84 signer", () => {
    expect(() => assertChargebackE2ENetwork("base_staging", 8453, CHARGEBACK_E2E_DEPLOYER)).not.to.throw();
    expect(() => assertChargebackE2ENetwork("base", 8453, CHARGEBACK_E2E_DEPLOYER))
      .to.throw("Base staging only");
    expect(() => assertChargebackE2ENetwork("base_staging", 31337, CHARGEBACK_E2E_DEPLOYER))
      .to.throw("requires chain 8453");
    expect(() => assertChargebackE2ENetwork("base_staging", 8453, ethers.constants.AddressZero))
      .to.throw("requires deployer");
  });

  it("derives a run-scoped method and unique payment/dispute identifiers", () => {
    const positive = deriveRunIdentifiers("run-20260716", "positive");
    const negative = deriveRunIdentifiers("run-20260716", "negative");
    expect(positive.paymentMethod).to.eq(negative.paymentMethod);
    expect(positive.originalPaymentId).not.to.eq(negative.originalPaymentId);
    expect(positive.disputeId).not.to.eq(negative.disputeId);
    expect(positive.paymentMethod).not.to.eq(ethers.utils.id("venmo"));
  });

  it("deploys threshold verifiers that require two unique signatures", async () => {
    const signers = await ethers.getSigners();
    const payment = signers.slice(1, 4);
    const chargeback = signers.slice(4, 7);
    const factory = await ethers.getContractFactory("MultiAttestationVerifier");
    const paymentVerifier = await factory.deploy(payment.map((signer) => signer.address), 2);
    const chargebackVerifier = await factory.deploy(chargeback.map((signer) => signer.address), 2);
    const digest = ethers.utils.id("chargeback-e2e-deploy-test");
    const paymentSignatures = await Promise.all(payment.slice(0, 2).map((signer) => signer.signMessage(
      ethers.utils.arrayify(digest),
    )));
    const chargebackSignatures = await Promise.all(chargeback.slice(0, 2).map((signer) => signer.signMessage(
      ethers.utils.arrayify(digest),
    )));
    const ethSignedDigest = ethers.utils.hashMessage(ethers.utils.arrayify(digest));

    expect(await paymentVerifier.verify(ethSignedDigest, paymentSignatures, "0x")).to.eq(true);
    expect(await chargebackVerifier.verify(ethSignedDigest, chargebackSignatures, "0x")).to.eq(true);
    await expect(paymentVerifier.verify(ethSignedDigest, [paymentSignatures[0]], "0x"))
      .to.be.revertedWith("ThresholdSigVerifierUtils: req threshold exceeds signatures");
    await expect(chargebackVerifier.verify(
      ethSignedDigest,
      [chargebackSignatures[0], chargebackSignatures[0]],
      "0x",
    )).to.be.revertedWith("ThresholdSigVerifierUtils: Not enough valid witness signatures");
  });

  it("builds the exact payment and chargeback EIP-712 envelopes", async () => {
    const ids = deriveRunIdentifiers("run-typed-data");
    const paymentSigners = Array.from({ length: 3 }, () => ethers.Wallet.createRandom());
    const chargebackSigners = Array.from({ length: 3 }, () => ethers.Wallet.createRandom());
    const upvAddress = "0x00000000000000000000000000000000000000A1";
    const riskManagerAddress = "0x00000000000000000000000000000000000000B1";
    const intentHash = ethers.utils.id("typed-data-intent");
    const intent = {
      payeeId: ids.payeeId,
      amount: 200_000,
      paymentMethod: ids.paymentMethod,
      fiatCurrency: ethers.utils.id("USD"),
      conversionRate: ethers.utils.parseEther("1"),
      timestamp: 1_700_000_000,
    };
    const chainId = 8453;
    const paymentProof = await buildPaymentProof(
      { chainId, unifiedPaymentVerifier: { address: upvAddress } as any },
      paymentSigners,
      ids,
      intentHash,
      intent,
    );
    const decodedPayment = ethers.utils.defaultAbiCoder.decode(
      ["tuple(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash,bytes[] signatures,bytes data,bytes metadata)"],
      paymentProof,
    )[0];
    const paymentDigest = ethers.utils._TypedDataEncoder.hash(
      { name: "UnifiedPaymentVerifier", version: "1", chainId, verifyingContract: upvAddress },
      { PaymentAttestation: [
        { name: "intentHash", type: "bytes32" },
        { name: "releaseAmount", type: "uint256" },
        { name: "dataHash", type: "bytes32" },
      ] },
      {
        intentHash: decodedPayment.intentHash,
        releaseAmount: decodedPayment.releaseAmount,
        dataHash: decodedPayment.dataHash,
      },
    );
    expect(decodedPayment.signatures).to.have.length(2);
    expect(decodedPayment.signatures.map((signature: string) => ethers.utils.recoverAddress(paymentDigest, signature)))
      .to.have.members(paymentSigners.slice(0, 2).map((wallet) => wallet.address));

    const chargeback = await buildChargebackAttestation(
      { chainId, riskManager: { address: riskManagerAddress } as any },
      chargebackSigners,
      ids,
      intentHash,
    );
    const chargebackDigest = ethers.utils._TypedDataEncoder.hash(
      { name: "ZKP2P RiskManager", version: "1", chainId, verifyingContract: riskManagerAddress },
      { ChargebackAttestation: [
        { name: "intentHash", type: "bytes32" },
        { name: "dataHash", type: "bytes32" },
      ] },
      { intentHash: chargeback.intentHash, dataHash: chargeback.dataHash },
    );
    expect(chargeback.signatures).to.have.length(2);
    expect(chargeback.signatures.map((signature: string) => ethers.utils.recoverAddress(chargebackDigest, signature)))
      .to.have.members(chargebackSigners.slice(0, 2).map((wallet) => wallet.address));

    const decodedDetails = ethers.utils.defaultAbiCoder.decode(
      ["tuple(bytes32 paymentMethod,bytes32 originalPaymentId,bytes32 disputeId,uint256 paymentAmount,bytes32 paymentCurrency)"],
      chargeback.data,
    )[0];
    expect(decodedDetails.paymentMethod).to.eq(ids.paymentMethod);
    expect(decodedDetails.originalPaymentId).to.eq(ids.originalPaymentId);
    expect(decodedDetails.disputeId).to.eq(ids.disputeId);
    expect(decodedDetails.paymentAmount).to.eq(20);
    expect(decodedDetails.paymentCurrency).to.eq(ethers.utils.id("USD"));
  });
});
