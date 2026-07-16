import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("EpochMultiAttestationVerifier", () => {
  const DELAY = 2 * 24 * 60 * 60;
  const domain = {
    name: "Epoch verifier test",
    version: "1",
    chainId: 31337,
    verifyingContract: ethers.constants.AddressZero,
  };
  const types = { TestAttestation: [{ name: "value", type: "uint256" }] };
  const value = { value: 42 };

  async function deployFixture() {
    const [owner, witnessA, witnessB, witnessC, witnessD, witnessE, witnessF, other] =
      await ethers.getSigners();
    const verifier = await (await ethers.getContractFactory("EpochMultiAttestationVerifier")).deploy(
      [witnessA.address, witnessB.address, witnessC.address],
      2,
      DELAY,
    );
    return { owner, witnessA, witnessB, witnessC, witnessD, witnessE, witnessF, other, verifier };
  }

  async function signature(signer: Awaited<ReturnType<typeof ethers.getSigners>>[number]) {
    return signer._signTypedData(domain, types, value);
  }

  function digest() {
    return ethers.utils._TypedDataEncoder.hash(domain, types, value);
  }

  it("requires the configured 2-of-3 independent signatures", async () => {
    const { witnessA, witnessB, verifier } = await deployFixture();
    const sigA = await signature(witnessA);
    const sigB = await signature(witnessB);

    await expect(verifier.verify(digest(), [sigA], "0x")).to.be.revertedWith(
      "ThresholdSigVerifierUtils: req threshold exceeds signatures",
    );
    expect(await verifier.verify(digest(), [sigA, sigB], "0x")).to.eq(true);
  });

  it("activates a complete witness configuration only after the governance delay", async () => {
    const { witnessA, witnessB, witnessD, witnessE, witnessF, verifier } = await deployFixture();
    const epochOneTimestamp = await verifier.epochActivatedAt(1);
    const epochOneSigA = await signature(witnessA);
    const epochOneSigB = await signature(witnessB);

    await verifier.proposeConfiguration([witnessD.address, witnessE.address, witnessF.address], 2);
    expect(await verifier.currentEpoch()).to.eq(1);
    expect(await verifier.isWitness(witnessA.address)).to.eq(true);
    await expect(verifier.activatePendingConfiguration()).to.be.revertedWith("EMAV: delay active");

    await time.increase(DELAY);
    await verifier.activatePendingConfiguration();
    expect(await verifier.currentEpoch()).to.eq(2);
    expect(await verifier.isWitness(witnessA.address)).to.eq(false);
    expect(await verifier.isWitness(witnessD.address)).to.eq(true);
    expect(await verifier.epochAt(epochOneTimestamp)).to.eq(1);
    expect(await verifier.epochAt(await time.latest())).to.eq(2);

    expect(await verifier.verifyAtEpoch(1, digest(), [epochOneSigA, epochOneSigB], "0x")).to.eq(true);
    await expect(verifier.verify(digest(), [epochOneSigA, epochOneSigB], "0x")).to.be.revertedWith(
      "ThresholdSigVerifierUtils: Not enough valid witness signatures",
    );
  });

  it("supports cancellation without mutating the active epoch", async () => {
    const { witnessD, witnessE, witnessF, verifier } = await deployFixture();
    await verifier.proposeConfiguration([witnessD.address, witnessE.address, witnessF.address], 2);
    expect(await verifier.pendingConfigurationHash()).to.not.eq(ethers.constants.HashZero);

    await verifier.cancelPendingConfiguration();
    expect(await verifier.pendingConfigurationHash()).to.eq(ethers.constants.HashZero);
    expect(await verifier.currentEpoch()).to.eq(1);
  });

  it("immutably enforces 2-of-3 and rejects duplicate or zero witnesses", async () => {
    const { witnessA, witnessB, witnessC, witnessD, verifier } = await deployFixture();
    await expect(
      verifier.proposeConfiguration([witnessA.address, witnessA.address, witnessB.address], 2),
    ).to.be.revertedWith(
      "EMAV: duplicate witness",
    );
    await expect(
      verifier.proposeConfiguration([ethers.constants.AddressZero, witnessB.address, witnessC.address], 2),
    ).to.be.revertedWith("EMAV: zero witness");
    await expect(verifier.proposeConfiguration([witnessA.address, witnessB.address], 2)).to.be.revertedWith(
      "EMAV: witness count must be three",
    );
    await expect(
      verifier.proposeConfiguration([witnessA.address, witnessB.address, witnessC.address, witnessD.address], 2),
    ).to.be.revertedWith("EMAV: witness count must be three");
    await expect(verifier.proposeConfiguration([witnessA.address, witnessB.address, witnessC.address], 1)).to.be.revertedWith(
      "EMAV: threshold must be two",
    );
  });

  it("restricts proposal and cancellation to governance", async () => {
    const { witnessD, witnessE, witnessF, other, verifier } = await deployFixture();
    await expect(
      verifier.connect(other).proposeConfiguration([witnessD.address, witnessE.address, witnessF.address], 2),
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await verifier.proposeConfiguration([witnessD.address, witnessE.address, witnessF.address], 2);
    await expect(verifier.connect(other).cancelPendingConfiguration()).to.be.revertedWith(
      "Ownable: caller is not the owner",
    );
  });
});
