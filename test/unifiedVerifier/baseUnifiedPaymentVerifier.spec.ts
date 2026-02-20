import "module-alias/register";

import { ethers } from "hardhat";

import { BaseUnifiedPaymentVerifier, NullifierRegistry, OrchestratorRegistry, SimpleAttestationVerifier } from "@utils/contracts";
import { Account } from "@utils/test/types";
import { Address } from "@utils/types";
import DeployHelper from "@utils/deploys";

import {
  getWaffleExpect,
  getAccounts
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("BaseUnifiedPaymentVerifier", () => {
  let owner: Account;
  let attacker: Account;
  let escrow: Account;
  let witness1: Account;
  let _unused: Account;

  let BaseUnifiedPaymentVerifier: BaseUnifiedPaymentVerifier;
  let attestationVerifier: SimpleAttestationVerifier;
  let nullifierRegistry: NullifierRegistry;
  let orchestratorRegistry: OrchestratorRegistry;

  let deployer: DeployHelper;

  const venmoPaymentMethodHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
  const paypalPaymentMethodHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("paypal"));


  beforeEach(async () => {
    [
      owner,
      attacker,
      escrow,
      witness1,
      _unused
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    // Deploy the nullifier registry
    nullifierRegistry = await deployer.deployNullifierRegistry();

    attestationVerifier = await deployer.deploySimpleAttestationVerifier(
      witness1.address
    );

    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    await orchestratorRegistry.addOrchestrator(escrow.address);

    // Deploy the UnifiedPaymentVerifier (which inherits BaseUnifiedPaymentVerifier functionality)
    BaseUnifiedPaymentVerifier = await deployer.deployUnifiedPaymentVerifier(
      orchestratorRegistry.address,
      nullifierRegistry.address,
      attestationVerifier.address
    );
  });

  describe("#constructor", async () => {
    it("should set the correct orchestrator registry address", async () => {
      const registryAddress = await BaseUnifiedPaymentVerifier.orchestratorRegistry();
      expect(registryAddress).to.eq(orchestratorRegistry.address);
    });

    it("should set the correct nullifier registry", async () => {
      const nullifierRegistryAddress = await BaseUnifiedPaymentVerifier.nullifierRegistry();
      expect(nullifierRegistryAddress).to.eq(nullifierRegistry.address);
    });

    it("should set the correct attestation verifier", async () => {
      const attestationVerifierAddress = await BaseUnifiedPaymentVerifier.attestationVerifier();
      expect(attestationVerifierAddress).to.eq(attestationVerifier.address);
    });

    it("should have the correct owner set", async () => {
      const contractOwner = await BaseUnifiedPaymentVerifier.owner();
      expect(contractOwner).to.eq(owner.address);
    });
  });

  describe("#setAttestationVerifier", async () => {
    let subjectAttestationVerifier: Address;
    let subjectCaller: Account;

    let newAttestationVerifier: SimpleAttestationVerifier;

    beforeEach(async () => {
      newAttestationVerifier = await deployer.deploySimpleAttestationVerifier(
        witness1.address
      );

      subjectAttestationVerifier = newAttestationVerifier.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await BaseUnifiedPaymentVerifier.connect(subjectCaller.wallet).setAttestationVerifier(subjectAttestationVerifier);
    }

    it("should update the attestation verifier", async () => {
      await subject();
      const attestationVerifierAddress = await BaseUnifiedPaymentVerifier.attestationVerifier();
      expect(attestationVerifierAddress).to.eq(subjectAttestationVerifier);
    });

    it("should emit the AttestationVerifierUpdated event", async () => {
      await expect(subject()).to.emit(BaseUnifiedPaymentVerifier, "AttestationVerifierUpdated")
        .withArgs(attestationVerifier.address, subjectAttestationVerifier);
    });

    describe("when attestation verifier is zero", async () => {
      beforeEach(async () => {
        subjectAttestationVerifier = ethers.constants.AddressZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Invalid attestation verifier");
      });
    });

    describe("when attestation verifier is the same as current", async () => {
      beforeEach(async () => {
        // Get the current attestation verifier address
        subjectAttestationVerifier = attestationVerifier.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Same verifier");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#setOrchestratorRegistry", async () => {
    let subjectOrchestratorRegistry: Address;
    let subjectCaller: Account;

    let newOrchestratorRegistry: OrchestratorRegistry;

    beforeEach(async () => {
      newOrchestratorRegistry = await deployer.deployOrchestratorRegistry();
      subjectOrchestratorRegistry = newOrchestratorRegistry.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return BaseUnifiedPaymentVerifier.connect(subjectCaller.wallet).setOrchestratorRegistry(subjectOrchestratorRegistry);
    }

    it("should update the orchestrator registry", async () => {
      await subject();
      expect(await BaseUnifiedPaymentVerifier.orchestratorRegistry()).to.eq(subjectOrchestratorRegistry);
    });

    it("should emit the OrchestratorRegistryUpdated event", async () => {
      await expect(subject())
        .to.emit(BaseUnifiedPaymentVerifier, "OrchestratorRegistryUpdated")
        .withArgs(orchestratorRegistry.address, subjectOrchestratorRegistry);
    });

    describe("when orchestrator registry is zero", async () => {
      beforeEach(async () => {
        subjectOrchestratorRegistry = ethers.constants.AddressZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Invalid orchestrator registry");
      });
    });

    describe("when orchestrator registry is the same as current", async () => {
      beforeEach(async () => {
        subjectOrchestratorRegistry = orchestratorRegistry.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Same registry");
      });
    });

    describe("when caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#addPaymentMethod", async () => {
    let subjectPaymentMethod: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      subjectPaymentMethod = venmoPaymentMethodHash;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await BaseUnifiedPaymentVerifier.connect(subjectCaller.wallet).addPaymentMethod(
        subjectPaymentMethod,
      );
    }

    it("should add the payment method", async () => {
      await subject();

      const paymentMethods = await BaseUnifiedPaymentVerifier.getPaymentMethods();
      const isPaymentMethod = await BaseUnifiedPaymentVerifier.isPaymentMethod(subjectPaymentMethod);

      expect(paymentMethods).to.contain(subjectPaymentMethod);
      expect(isPaymentMethod).to.be.true;
    });


    it("should emit the PaymentMethodAdded event", async () => {
      await expect(subject()).to.emit(BaseUnifiedPaymentVerifier, "PaymentMethodAdded")
        .withArgs(subjectPaymentMethod);
    });

    describe("when payment method already exists", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Payment method already exists");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#removePaymentMethod", async () => {
    let subjectPaymentMethod: string;
    let subjectCaller: Account;

    beforeEach(async () => {
      // Add a payment method with multiple processors
      await BaseUnifiedPaymentVerifier.addPaymentMethod(
        venmoPaymentMethodHash,
      );

      subjectPaymentMethod = venmoPaymentMethodHash;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return await BaseUnifiedPaymentVerifier.connect(subjectCaller.wallet).removePaymentMethod(subjectPaymentMethod);
    }

    it("should remove the payment method", async () => {
      await subject();

      const paymentMethods = await BaseUnifiedPaymentVerifier.getPaymentMethods();
      expect(paymentMethods).to.not.contain(subjectPaymentMethod);

      const isPaymentMethod = await BaseUnifiedPaymentVerifier.isPaymentMethod(subjectPaymentMethod);
      expect(isPaymentMethod).to.be.false;
    });

    it("should emit the PaymentMethodRemoved event", async () => {
      await expect(subject()).to.emit(BaseUnifiedPaymentVerifier, "PaymentMethodRemoved")
        .withArgs(subjectPaymentMethod);
    });

    describe("when payment method does not exist", async () => {
      beforeEach(async () => {
        subjectPaymentMethod = paypalPaymentMethodHash;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UPV: Payment method does not exist");
      });
    });

    describe("when the caller is not the owner", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("view functions", async () => {
    beforeEach(async () => {
      // Add multiple payment methods for testing
      await BaseUnifiedPaymentVerifier.addPaymentMethod(
        venmoPaymentMethodHash,
      );

      await BaseUnifiedPaymentVerifier.addPaymentMethod(
        paypalPaymentMethodHash,
      );
    });

    describe("#getPaymentMethods", async () => {
      it("should return all payment methods", async () => {
        const paymentMethods = await BaseUnifiedPaymentVerifier.getPaymentMethods();
        expect(paymentMethods).to.contain(venmoPaymentMethodHash);
        expect(paymentMethods).to.contain(paypalPaymentMethodHash);
        expect(paymentMethods.length).to.eq(2);
      });
    });

    describe("#isPaymentMethod", async () => {
      it("should return true for existing payment method", async () => {
        const isPaymentMethod = await BaseUnifiedPaymentVerifier.isPaymentMethod(venmoPaymentMethodHash);
        expect(isPaymentMethod).to.be.true;
      });
    });
  });
});
