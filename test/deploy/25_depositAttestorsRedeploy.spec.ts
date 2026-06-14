import "module-alias/register";

import { deployments } from "hardhat";

import {
  MultiAttestationVerifier,
  MultiAttestationVerifier__factory,
  NullifierRegistry,
  NullifierRegistry__factory,
  PaymentVerifierRegistry,
  PaymentVerifierRegistry__factory,
  UnifiedPaymentVerifier,
  UnifiedPaymentVerifier__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";
import {
  Address
} from "../../utils/types";
import {
  DEPOSIT_ATTESTORS_TAG,
  encodeDepositAttestors,
} from "../../utils/unifiedVerifierUtils";

import {
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
} from "../../deployments/parameters";
import { getDeployedContractAddress } from "../../deployments/helpers";
import { N26_PROVIDER_CONFIG } from "../../deployments/verifiers/n26";
import { LUXON_PROVIDER_CONFIG } from "../../deployments/verifiers/luxon";

const expect = getWaffleExpect();

describe("Deposit Attestor Wiring", () => {
  let deployer: Account;
  let additionalAttestor: Account;
  let multiSig: Address;

  let multiAttestationVerifier: MultiAttestationVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let nullifierRegistry: NullifierRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;

  const network: string = deployments.getNetworkName();

  before(async () => {
    [deployer, additionalAttestor] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;

    const multiAttestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");
    multiAttestationVerifier = new MultiAttestationVerifier__factory(deployer.wallet).attach(multiAttestationVerifierAddress);

    // UnifiedPaymentVerifierV2 shares the base verifier ABI with UnifiedPaymentVerifier,
    // so we attach the V1 typechain factory — same pattern used by test/deploy/14_v2System.spec.ts.
    const upvV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(upvV2Address);

    const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
    nullifierRegistry = new NullifierRegistry__factory(deployer.wallet).attach(nullifierRegistryAddress);

    const paymentVerifierRegistryAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);
  });

  describe("MultiAttestationVerifier deposit attestors", async () => {
    it("should expose the deposit attestors tag used by clients", async () => {
      const actualTag = await multiAttestationVerifier.DEPOSIT_ATTESTORS_TAG();
      expect(actualTag).to.eq(DEPOSIT_ATTESTORS_TAG);
    });

    it("should resolve empty deposit data to the configured witness set", async () => {
      const [attestors, threshold] = await multiAttestationVerifier.resolveAttestors("0x");

      const expectedWitnesses = MULTI_WITNESS_ADDRESSES[network].map((w) => w.toLowerCase());
      expect(attestors.map((a) => a.toLowerCase())).to.have.members(expectedWitnesses);
      expect(threshold.toNumber()).to.eq(MULTI_WITNESS_THRESHOLD[network]);
    });

    it("should resolve tagged deposit data to the witness set plus depositor attestors", async () => {
      const depositAttestorsData = encodeDepositAttestors(
        [additionalAttestor.address],
        MULTI_WITNESS_THRESHOLD[network]
      );

      const [attestors, threshold] = await multiAttestationVerifier.resolveAttestors(depositAttestorsData);

      const expectedAttestors = [
        ...MULTI_WITNESS_ADDRESSES[network],
        additionalAttestor.address,
      ].map((attestor) => attestor.toLowerCase());
      expect(attestors.map((attestor) => attestor.toLowerCase())).to.deep.eq(expectedAttestors);
      expect(threshold.toNumber()).to.eq(MULTI_WITNESS_THRESHOLD[network]);
    });
  });

  describe("UnifiedPaymentVerifierV2 wiring", async () => {
    it("should point at the MultiAttestationVerifier", async () => {
      const actualAttestationVerifier = await unifiedPaymentVerifierV2.attestationVerifier();
      expect(actualAttestationVerifier).to.eq(multiAttestationVerifier.address);
    });

    it("should have write permission on the NullifierRegistry", async () => {
      expect(await nullifierRegistry.isWriter(unifiedPaymentVerifierV2.address)).to.be.true;
    });

    it("should be the registered verifier for every payment method", async () => {
      const paymentMethods = await paymentVerifierRegistry.getPaymentMethods();
      expect(paymentMethods.length).to.be.gt(0);

      for (const paymentMethod of paymentMethods) {
        const actualVerifier = await paymentVerifierRegistry.getVerifier(paymentMethod);
        expect(actualVerifier).to.eq(unifiedPaymentVerifierV2.address);
      }
    });

    it("should configure the new verifier for every registered payment method", async () => {
      const registryPaymentMethods = await paymentVerifierRegistry.getPaymentMethods();
      const verifierPaymentMethods = await unifiedPaymentVerifierV2.getPaymentMethods();

      expect(verifierPaymentMethods.map((m) => m.toLowerCase())).to.include.members(
        registryPaymentMethods.map((m) => m.toLowerCase())
      );
    });

    it("should remove deprecated payment methods from the registry", async () => {
      expect(await paymentVerifierRegistry.isPaymentMethod(N26_PROVIDER_CONFIG.paymentMethodHash)).to.be.false;
      expect(await paymentVerifierRegistry.isPaymentMethod(LUXON_PROVIDER_CONFIG.paymentMethodHash)).to.be.false;
    });

    it("should have ownership transferred to the multisig", async () => {
      const actualOwner = await unifiedPaymentVerifierV2.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });
});
