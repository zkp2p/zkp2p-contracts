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
  ATTESTOR_OVERRIDE_TAG,
  encodeAttestorOverride,
} from "../../utils/unifiedVerifierUtils";

import {
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
} from "../../deployments/parameters";
import { getDeployedContractAddress } from "../../deployments/helpers";
import { VENMO_PROVIDER_CONFIG } from "../../deployments/verifiers/venmo";

const expect = getWaffleExpect();

describe("Depositor Attestor Override Wiring", () => {
  let deployer: Account;
  let multiSig: Address;

  let multiAttestationVerifier: MultiAttestationVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let nullifierRegistry: NullifierRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;

  const network: string = deployments.getNetworkName();

  before(async () => {
    [deployer] = await getAccounts();
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

  describe("MultiAttestationVerifier attestor overrides", async () => {
    it("should expose the attestor override tag used by clients", async () => {
      const actualTag = await multiAttestationVerifier.ATTESTOR_OVERRIDE_TAG();
      expect(actualTag).to.eq(ATTESTOR_OVERRIDE_TAG);
    });

    it("should resolve empty deposit data to the configured protocol witness set", async () => {
      const [attestors, threshold] = await multiAttestationVerifier.resolveAttestors("0x");

      const expectedWitnesses = MULTI_WITNESS_ADDRESSES[network].map((w) => w.toLowerCase());
      expect(attestors.map((a) => a.toLowerCase())).to.have.members(expectedWitnesses);
      expect(threshold.toNumber()).to.eq(MULTI_WITNESS_THRESHOLD[network]);
    });

    it("should resolve tagged deposit data to the depositor's attestor set", async () => {
      const overrideData = encodeAttestorOverride([deployer.address], 1);

      const [attestors, threshold] = await multiAttestationVerifier.resolveAttestors(overrideData);

      expect(attestors).to.deep.eq([deployer.address]);
      expect(threshold.toNumber()).to.eq(1);
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

    it("should be the registered verifier for payment methods", async () => {
      const actualVerifier = await paymentVerifierRegistry.getVerifier(VENMO_PROVIDER_CONFIG.paymentMethodHash);
      expect(actualVerifier).to.eq(unifiedPaymentVerifierV2.address);
    });

    it("should have ownership transferred to the multisig", async () => {
      const actualOwner = await unifiedPaymentVerifierV2.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });
});
