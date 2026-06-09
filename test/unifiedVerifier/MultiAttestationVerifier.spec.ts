import "module-alias/register";

import { ethers } from "hardhat";

import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
} from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { Account } from "@utils/test/types";
import { ATTESTOR_OVERRIDE_TAG, encodeAttestorOverride } from "@utils/unifiedVerifierUtils";
import { MultiAttestationVerifier } from "../../typechain";

const expect = getWaffleExpect();

describe("MultiAttestationVerifier", () => {
  let owner: Account;
  let nonOwner: Account;
  let witnessA: Account;
  let witnessB: Account;
  let witnessC: Account;
  let otherAccount: Account;

  let baseMultiAttestationVerifier: MultiAttestationVerifier;
  let multiAttestationVerifier: MultiAttestationVerifier;

  let messageHash: string;
  let digest: string;

  before(async () => {
    [
      owner,
      nonOwner,
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

    baseMultiAttestationVerifier = await deployVerifier([witnessA.address], 1);
    multiAttestationVerifier = baseMultiAttestationVerifier;
  });

  addSnapshotBeforeRestoreAfterEach();

  async function deployVerifier(
    initialWitnesses: string[],
    initialThreshold: number
  ): Promise<MultiAttestationVerifier> {
    const verifierFactory = await ethers.getContractFactory(
      "MultiAttestationVerifier",
      owner.wallet
    );

    const verifier = await verifierFactory.deploy(initialWitnesses, initialThreshold);
    await verifier.deployed();

    return verifier as MultiAttestationVerifier;
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
      subjectData = "0x";
    });

    async function subject(): Promise<boolean> {
      return multiAttestationVerifier.verify(
        subjectDigest,
        subjectSignatures,
        subjectData
      );
    }

    describe("when deployed with one witness and threshold 1", () => {
      beforeEach(async () => {
        multiAttestationVerifier = baseMultiAttestationVerifier;
        subjectSignatures = [await signWitness(witnessA)];
      });

      it("should return true with a valid signature from that witness", async () => {
        const result = await subject();

        expect(result).to.equal(true);
      });
    });

    describe("when deployed with two witnesses and threshold 1", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          1
        );
      });

      describe("when witness A signs the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [await signWitness(witnessA)];
        });

        it("should return true", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when witness B signs the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [await signWitness(witnessB)];
        });

        it("should return true", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when a non-witness signs the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [await signWitness(otherAccount)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ThresholdSigVerifierUtils: Not enough valid witness signatures"
          );
        });
      });

      describe("when the same witness signature is passed twice", () => {
        beforeEach(async () => {
          const duplicateSignature = await signWitness(witnessA);
          subjectSignatures = [duplicateSignature, duplicateSignature];
        });

        it("should return true because the unique signer threshold is still met", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });
    });

    describe("when deployed with two witnesses and threshold 2", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          2
        );
      });

      describe("when witness A and witness B sign the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [
            await signWitness(witnessA),
            await signWitness(witnessB),
          ];
        });

        it("should return true", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when the same witness signs twice", () => {
        beforeEach(async () => {
          const duplicateSignature = await signWitness(witnessA);
          subjectSignatures = [duplicateSignature, duplicateSignature];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith(
            "ThresholdSigVerifierUtils: Not enough valid witness signatures"
          );
        });
      });
    });

    describe("when deployed with three witnesses and threshold 3", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address, witnessC.address],
          3
        );

        const duplicateSignature = await signWitness(witnessA);
        subjectSignatures = [
          duplicateSignature,
          duplicateSignature,
          duplicateSignature,
        ];
      });

      it("should revert when the same signature bytes are replayed three times", async () => {
        await expect(subject()).to.be.revertedWith(
          "ThresholdSigVerifierUtils: Not enough valid witness signatures"
        );
      });
    });

    describe("when the data carries a depositor attestor override", () => {
      let customAttestorA: Account;
      let customAttestorB: Account;

      beforeEach(async () => {
        customAttestorA = otherAccount;
        customAttestorB = nonOwner;

        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          1
        );
        subjectData = encodeAttestorOverride([customAttestorA.address], 1);
      });

      describe("when the custom attestor signs the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should return true even though the signer is not a protocol witness", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when only a protocol witness signs the digest", () => {
        beforeEach(async () => {
          subjectSignatures = [await signWitness(witnessA)];
        });

        it("should revert because the override replaces the protocol witness set", async () => {
          await expect(subject()).to.be.revertedWith(
            "ThresholdSigVerifierUtils: Not enough valid witness signatures"
          );
        });
      });

      describe("when the override requires 2-of-2 custom attestors", () => {
        beforeEach(() => {
          subjectData = encodeAttestorOverride(
            [customAttestorA.address, customAttestorB.address],
            2
          );
        });

        describe("when both custom attestors sign", () => {
          beforeEach(async () => {
            subjectSignatures = [
              await signWitness(customAttestorA),
              await signWitness(customAttestorB),
            ];
          });

          it("should return true", async () => {
            const result = await subject();

            expect(result).to.equal(true);
          });
        });

        describe("when only one custom attestor signs", () => {
          beforeEach(async () => {
            subjectSignatures = [await signWitness(customAttestorA)];
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "ThresholdSigVerifierUtils: req threshold exceeds signatures"
            );
          });
        });
      });

      describe("when the override includes a protocol witness explicitly", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride(
            [customAttestorA.address, witnessA.address],
            1
          );
          subjectSignatures = [await signWitness(witnessA)];
        });

        it("should return true", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when the override has no attestors", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride([], 1);
          subjectSignatures = [await signWitness(witnessA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: empty override attestors");
        });
      });

      describe("when the override exceeds the max attestor count", () => {
        beforeEach(async () => {
          const attestors = Array.from({ length: 11 }, (_, index) =>
            ethers.utils.getAddress(
              ethers.utils.hexZeroPad(ethers.utils.hexlify(index + 1), 20)
            )
          );
          subjectData = encodeAttestorOverride(attestors, 1);
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: too many override attestors");
        });
      });

      describe("when the override threshold is zero", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride([customAttestorA.address], 0);
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: override threshold must be > 0");
        });
      });

      describe("when the override threshold exceeds the attestor count", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride([customAttestorA.address], 2);
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: override threshold exceeds count");
        });
      });

      describe("when the override contains the zero address", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride([customAttestorA.address, ADDRESS_ZERO], 1);
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: zero override attestor");
        });
      });

      describe("when the override contains a duplicate attestor", () => {
        beforeEach(async () => {
          subjectData = encodeAttestorOverride(
            [customAttestorA.address, customAttestorA.address],
            1
          );
          subjectSignatures = [await signWitness(customAttestorA)];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("MAV: duplicate override attestor");
        });
      });

      describe("when the data is tagged but malformed", () => {
        beforeEach(async () => {
          subjectData = ATTESTOR_OVERRIDE_TAG; // tag only, no attestor payload
          subjectSignatures = [await signWitness(witnessA)];
        });

        it("should revert instead of falling back to the protocol witness set", async () => {
          await expect(subject()).to.be.reverted;
        });
      });
    });

    describe("when the data is untagged", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          1
        );
        subjectSignatures = [await signWitness(witnessA)];
      });

      describe("when the data is legacy witness data (abi-encoded address array)", () => {
        beforeEach(() => {
          subjectData = ethers.utils.defaultAbiCoder.encode(
            ["address[]"],
            [[otherAccount.address]]
          );
        });

        it("should fall back to the protocol witness set", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });

        describe("when the address in the legacy data signs instead of a witness", () => {
          beforeEach(async () => {
            subjectSignatures = [await signWitness(otherAccount)];
          });

          it("should revert because legacy data does not override the witness set", async () => {
            await expect(subject()).to.be.revertedWith(
              "ThresholdSigVerifierUtils: Not enough valid witness signatures"
            );
          });
        });
      });

      describe("when the data is shorter than 32 bytes", () => {
        beforeEach(() => {
          subjectData = "0x1234";
        });

        it("should fall back to the protocol witness set", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });

      describe("when the data is 32+ bytes of non-tag content", () => {
        beforeEach(() => {
          subjectData = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("unrelated"));
        });

        it("should fall back to the protocol witness set", async () => {
          const result = await subject();

          expect(result).to.equal(true);
        });
      });
    });
  });

  describe("#resolveAttestors", () => {
    let subjectData: string;

    beforeEach(async () => {
      multiAttestationVerifier = await deployVerifier(
        [witnessA.address, witnessB.address],
        2
      );
      subjectData = "0x";
    });

    async function subject(): Promise<[string[], any]> {
      return multiAttestationVerifier.resolveAttestors(subjectData);
    }

    it("should expose the tag constant used by integrators", async () => {
      expect(await multiAttestationVerifier.ATTESTOR_OVERRIDE_TAG()).to.equal(
        ATTESTOR_OVERRIDE_TAG
      );
    });

    describe("when the data is empty", () => {
      it("should return the protocol witness set and threshold", async () => {
        const [attestors, threshold] = await subject();

        expect(attestors).to.have.deep.members([witnessA.address, witnessB.address]);
        expect(threshold).to.equal(2);
      });
    });

    describe("when the data carries an override", () => {
      beforeEach(() => {
        subjectData = encodeAttestorOverride([otherAccount.address], 1);
      });

      it("should return the override attestors and threshold", async () => {
        const [attestors, threshold] = await subject();

        expect(attestors).to.deep.equal([otherAccount.address]);
        expect(threshold).to.equal(1);
      });
    });
  });

  describe("#constructor", () => {
    let subjectWitnesses: string[];
    let subjectThreshold: number;

    beforeEach(() => {
      subjectWitnesses = [witnessA.address];
      subjectThreshold = 1;
    });

    async function subject(): Promise<MultiAttestationVerifier> {
      return deployVerifier(subjectWitnesses, subjectThreshold);
    }

    describe("when the initial witness set contains the zero address", () => {
      beforeEach(() => {
        subjectWitnesses = [witnessA.address, ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: zero witness");
      });
    });

    describe("when the initial witness set contains a duplicate", () => {
      beforeEach(() => {
        subjectWitnesses = [witnessA.address, witnessA.address];
        subjectThreshold = 2;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: duplicate witness");
      });
    });

    describe("when the initial threshold is zero", () => {
      beforeEach(() => {
        subjectThreshold = 0;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: threshold must be > 0");
      });
    });

    describe("when the initial threshold exceeds the witness count", () => {
      beforeEach(() => {
        subjectWitnesses = [witnessA.address];
        subjectThreshold = 2;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: threshold exceeds count");
      });
    });
  });

  describe("#addWitness", () => {
    let subjectWitness: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      multiAttestationVerifier = await deployVerifier([witnessA.address], 1);
      subjectWitness = witnessB.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return multiAttestationVerifier
        .connect(subjectCaller.wallet)
        .addWitness(subjectWitness);
    }

    describe("when called by the owner with a new witness", () => {
      it("should emit WitnessAdded and increase the witness count", async () => {
        const transaction = await subject();

        await expect(transaction)
          .to.emit(multiAttestationVerifier, "WitnessAdded")
          .withArgs(subjectWitness);

        expect(await multiAttestationVerifier.witnessCount()).to.equal(2);
      });
    });

    describe("when called by a non-owner", () => {
      beforeEach(() => {
        subjectCaller = nonOwner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "Ownable: caller is not the owner"
        );
      });
    });

    describe("when the new witness is the zero address", () => {
      beforeEach(() => {
        subjectWitness = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: zero witness");
      });
    });

    describe("when the witness already exists", () => {
      beforeEach(() => {
        subjectWitness = witnessA.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: already a witness");
      });
    });
  });

  describe("#removeWitness", () => {
    let subjectWitness: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      multiAttestationVerifier = await deployVerifier(
        [witnessA.address, witnessB.address],
        1
      );
      subjectWitness = witnessB.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return multiAttestationVerifier
        .connect(subjectCaller.wallet)
        .removeWitness(subjectWitness);
    }

    describe("when called by the owner for an existing witness", () => {
      it("should emit WitnessRemoved and decrease the witness count", async () => {
        const transaction = await subject();

        await expect(transaction)
          .to.emit(multiAttestationVerifier, "WitnessRemoved")
          .withArgs(subjectWitness);

        expect(await multiAttestationVerifier.witnessCount()).to.equal(1);
      });
    });

    describe("when the removal would drop the set below the threshold", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier([witnessA.address], 1);
        subjectWitness = witnessA.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: below threshold");
      });
    });

    describe("when the witness is not in the set", () => {
      beforeEach(() => {
        subjectWitness = witnessC.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: not a witness");
      });
    });
  });

  describe("#setRequiredSignatures", () => {
    let subjectRequiredSignatures: number;
    let subjectCaller: Account;

    beforeEach(async () => {
      multiAttestationVerifier = await deployVerifier(
        [witnessA.address, witnessB.address],
        1
      );
      subjectRequiredSignatures = 2;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return multiAttestationVerifier
        .connect(subjectCaller.wallet)
        .setRequiredSignatures(subjectRequiredSignatures);
    }

    describe("when called by the owner with a valid threshold", () => {
      it("should emit RequiredSignaturesUpdated and update the threshold", async () => {
        const transaction = await subject();

        await expect(transaction)
          .to.emit(multiAttestationVerifier, "RequiredSignaturesUpdated")
          .withArgs(1, subjectRequiredSignatures);

        expect(await multiAttestationVerifier.requiredSignatures()).to.equal(
          subjectRequiredSignatures
        );
      });
    });

    describe("when the new threshold is zero", () => {
      beforeEach(() => {
        subjectRequiredSignatures = 0;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: threshold must be > 0");
      });
    });

    describe("when the new threshold exceeds the witness count", () => {
      beforeEach(() => {
        subjectRequiredSignatures = 3;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAV: exceeds witness count");
      });
    });
  });

  describe("view helpers", () => {
    describe("#witnesses", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          1
        );

        await multiAttestationVerifier.connect(owner.wallet).addWitness(witnessC.address);
        await multiAttestationVerifier.connect(owner.wallet).removeWitness(witnessA.address);
      });

      it("should return the current witness set", async () => {
        expect(await multiAttestationVerifier.witnesses()).to.have.deep.members([
          witnessB.address,
          witnessC.address,
        ]);
      });
    });

    describe("#isWitness", () => {
      beforeEach(async () => {
        multiAttestationVerifier = await deployVerifier(
          [witnessA.address, witnessB.address],
          1
        );
      });

      it("should return the correct boolean", async () => {
        expect(await multiAttestationVerifier.isWitness(witnessA.address)).to.equal(true);
        expect(await multiAttestationVerifier.isWitness(witnessC.address)).to.equal(false);
      });
    });
  });
});
