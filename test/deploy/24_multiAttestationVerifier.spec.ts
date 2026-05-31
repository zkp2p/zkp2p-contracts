import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  UnifiedPaymentVerifier,
} from "../../utils/contracts";
import {
  UnifiedPaymentVerifier__factory,
} from "../../typechain";

import {
  getAccounts,
  getWaffleExpect,
} from "../../utils/test";
import {
  Account
} from "../../utils/test/types";
import { getDeployedContractAddress } from "../../deployments/helpers";

const expect = getWaffleExpect();

describe("MultiAttestationVerifier Deployment", () => {
  let deployer: Account;

  let multiAttestationVerifierAddress: string;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;

  const network: string = deployments.getNetworkName();

  before(async () => {
    [deployer] = await getAccounts();

    multiAttestationVerifierAddress = getDeployedContractAddress(network, "MultiAttestationVerifier");

    // UnifiedPaymentVerifierV2 shares the base verifier ABI with UnifiedPaymentVerifier,
    // so we attach the V1 typechain factory — same pattern used by test/deploy/14_v2System.spec.ts.
    const upvV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(upvV2Address);
  });

  describe("MultiAttestationVerifier", async () => {
    it("should be deployed", async () => {
      const deployedCode = await ethers.provider.getCode(multiAttestationVerifierAddress);

      expect(deployedCode).to.not.eq("0x");
    });
  });

  describe("UnifiedPaymentVerifierV2 Wiring", async () => {
    it("should have UnifiedPaymentVerifierV2.attestationVerifier set to MultiAttestationVerifier", async () => {
      const actualAttestationVerifier = await unifiedPaymentVerifierV2.attestationVerifier();
      expect(actualAttestationVerifier).to.eq(multiAttestationVerifierAddress);
    });
  });
});
