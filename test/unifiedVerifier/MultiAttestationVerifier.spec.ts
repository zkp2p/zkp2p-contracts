import "module-alias/register";

import { ethers } from "hardhat";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { Account } from "@utils/test/types";
import { MultiAttestationVerifier } from "../../typechain";

const expect = getWaffleExpect();

describe("MultiAttestationVerifier", () => {
  let witnessA: Account;
  let witnessB: Account;
  let witnessC: Account;
  let otherAccount: Account;

  let multiAttestationVerifier: MultiAttestationVerifier;

  let messageHash: string;
  let digest: string;

  before(async () => {
    [
      ,
      ,
      witnessA,
      witnessB,
      witnessC,
      otherAccount,
    ] = await getAccounts();

    messageHash = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes("Test attestation message")
    );
    digest = ethers.utils.keccak256(
      ethers.utils.concat([
        ethers.utils.toUtf8Bytes("\x19Ethereum Signed Message:\n32"),
        messageHash,
      ])
    );

    multiAttestationVerifier = await deployVerifier();
  });

  addSnapshotBeforeRestoreAfterEach();

  async function deployVerifier(): Promise<MultiAttestationVerifier> {
    const verifierFactory = await ethers.getContractFactory(
      "MultiAttestationVerifier"
    );

    const verifier = await verifierFactory.deploy();
    await verifier.deployed();

    return verifier as MultiAttestationVerifier;
  }

  function encodeWitnessConfig(
    witnesses: string[],
    requiredSignatures: number
  ): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["address[]", "uint256"],
      [witnesses, requiredSignatures]
    );
  }

  async function signWitness(
    signer: Account,
    hashToSign?: string
  ): Promise<string> {
    return signer.wallet.signMessage(
      ethers.utils.arrayify(hashToSign ?? messageHash)
    );
  }

  describe("#verify", () => {
    let subjectDigest: string;
    let subjectSignatures: string[];
    let subjectData: string;

    beforeEach(() => {
      subjectDigest = digest;
      subjectSignatures = [];
      subjectData = encodeWitnessConfig([witnessA.address], 1);
    });

    async function subject(): Promise<boolean> {
      return multiAttestationVerifier.verify(
        subjectDigest,
        subjectSignatures,
        subjectData
      );
    }

    describe("when the configured witness signs and threshold is one", () => {
      beforeEach(async () => {
        subjectSignatures = [await signWitness(witnessA)];
      });

      it("should return true", async () => {
        const result = await subject();

        expect(result).to.equal(true);
      });
    });

    describe("when one of several configured witnesses signs and threshold is one", () => {
      beforeEach(async () => {
        subjectData = encodeWitnessConfig(
          [witnessA.address, witnessB.address],
          1
        );
        subjectSignatures = [await signWitness(witnessB)];
      });

      it("should return true", async () => {
        const result = await subject();

        expect(result).to.equal(true);
      });
    });

    describe("when threshold is two and two configured witnesses sign", () => {
      beforeEach(async () => {
        subjectData = encodeWitnessConfig(
          [witnessA.address, witnessB.address, witnessC.address],
          2
        );
        subjectSignatures = [
          await signWitness(witnessA),
          await signWitness(witnessC),
        ];
      });

      it("should return true", async () => {
        const result = await subject();

        expect(result).to.equal(true);
      });
    });

    describe("when a non-configured witness signs", () => {
      beforeEach(async () => {
        subjectData = encodeWitnessConfig([witnessA.address, witnessB.address], 1);
        subjectSignatures = [await signWitness(otherAccount)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: Not enough valid witness signatures"
        );
      });
    });

    describe("when the same configured witness signs twice for threshold two", () => {
      beforeEach(async () => {
        const duplicateSignature = await signWitness(witnessA);
        subjectData = encodeWitnessConfig([witnessA.address, witnessB.address], 2);
        subjectSignatures = [duplicateSignature, duplicateSignature];
      });

      it("should revert because duplicate signatures only count once", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: Not enough valid witness signatures"
        );
      });
    });

    describe("when there are fewer signatures than the required threshold", () => {
      beforeEach(async () => {
        subjectData = encodeWitnessConfig([witnessA.address, witnessB.address], 2);
        subjectSignatures = [await signWitness(witnessA)];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: req threshold exceeds signatures"
        );
      });
    });
  });

  describe("witness config validation", () => {
    let subjectData: string;

    beforeEach(() => {
      subjectData = encodeWitnessConfig([witnessA.address], 1);
    });

    async function subject(): Promise<boolean> {
      return multiAttestationVerifier.verify(digest, [], subjectData);
    }

    it("should reach signature threshold validation when witness config is valid", async () => {
      await expect(subject()).to.be.revertedWith(
        "ThresholdSigVerifierUtils: req threshold exceeds signatures"
      );
    });

    describe("when data is empty", () => {
      beforeEach(() => {
        subjectData = "0x";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: witness config required");
      });
    });

    describe("when witnesses are empty", () => {
      beforeEach(() => {
        subjectData = encodeWitnessConfig([], 1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: empty witnesses");
      });
    });

    describe("when threshold is zero", () => {
      beforeEach(() => {
        subjectData = encodeWitnessConfig([witnessA.address], 0);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: threshold must be > 0");
      });
    });

    describe("when threshold exceeds witness count", () => {
      beforeEach(() => {
        subjectData = encodeWitnessConfig([witnessA.address], 2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: threshold exceeds count");
      });
    });

    describe("when a witness is the zero address", () => {
      beforeEach(() => {
        subjectData = encodeWitnessConfig([witnessA.address, ADDRESS_ZERO], 1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: zero witness");
      });
    });

    describe("when the witness config contains duplicates", () => {
      beforeEach(() => {
        subjectData = encodeWitnessConfig([witnessA.address, witnessA.address], 1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: duplicate witness");
      });
    });
  });
});
