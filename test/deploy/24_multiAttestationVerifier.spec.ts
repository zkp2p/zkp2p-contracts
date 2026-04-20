import "module-alias/register";

import { deployments } from "hardhat";

import {
  UnifiedPaymentVerifier,
} from "../../utils/contracts";
import {
  MultiAttestationVerifier,
  MultiAttestationVerifier__factory,
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
  MULTI_SIG,
  MULTI_WITNESS_ADDRESSES,
  MULTI_WITNESS_THRESHOLD,
} from "../../deployments/parameters";
import { getDeployedContractAddress } from "../../deployments/helpers";

const expect = getWaffleExpect();

describe("MultiAttestationVerifier Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  let multiAttestationVerifier: MultiAttestationVerifier;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;

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
  });

  describe("MultiAttestationVerifier Constructor", async () => {
    it("should have the configured initial witness set", async () => {
      const actualWitnesses = (await multiAttestationVerifier.witnesses()).map((w) => w.toLowerCase());
      const expectedWitnesses = MULTI_WITNESS_ADDRESSES[network].map((w) => w.toLowerCase());
      expect(actualWitnesses).to.have.members(expectedWitnesses);
      expect(actualWitnesses.length).to.eq(expectedWitnesses.length);
    });

    it("should have the configured threshold", async () => {
      const actualThreshold = (await multiAttestationVerifier.requiredSignatures()).toNumber();
      const expectedThreshold = MULTI_WITNESS_THRESHOLD[network];
      expect(actualThreshold).to.eq(expectedThreshold);
    });

    it("should have every configured witness in the allowlist", async () => {
      for (const witness of MULTI_WITNESS_ADDRESSES[network]) {
        expect(await multiAttestationVerifier.isWitness(witness)).to.be.true;
      }
    });

    it("should report the configured witness count", async () => {
      const count = (await multiAttestationVerifier.witnessCount()).toNumber();
      expect(count).to.eq(MULTI_WITNESS_ADDRESSES[network].length);
    });
  });

  describe("MultiAttestationVerifier Ownership", async () => {
    it("should have ownership transferred to the multisig", async () => {
      const actualOwner = await multiAttestationVerifier.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("UnifiedPaymentVerifierV2 Wiring", async () => {
    it("should have UnifiedPaymentVerifierV2.attestationVerifier set to MultiAttestationVerifier", async () => {
      const actualAttestationVerifier = await unifiedPaymentVerifierV2.attestationVerifier();
      expect(actualAttestationVerifier).to.eq(multiAttestationVerifier.address);
    });
  });
});
