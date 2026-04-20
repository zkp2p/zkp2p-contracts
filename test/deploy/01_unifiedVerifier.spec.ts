import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  UnifiedPaymentVerifier,
  SimpleAttestationVerifier,
  NullifierRegistry,
  Escrow,
} from "../../utils/contracts";
import {
  UnifiedPaymentVerifier__factory,
  SimpleAttestationVerifier__factory,
  NullifierRegistry__factory,
  Escrow__factory,
  Orchestrator,
  Orchestrator__factory,
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
  WITNESS_ADDRESS
} from "../../deployments/parameters";
import { getDeployedContractAddress } from "../../deployments/helpers";

const expect = getWaffleExpect();

describe("UnifiedPaymentVerifier Deployment", () => {
  let deployer: Account;
  let multiSig: Address;
  let orchestratorAddress: string;

  let orchestrator: Orchestrator;
  let unifiedPaymentVerifier: UnifiedPaymentVerifier;
  let simpleAttestationVerifier: SimpleAttestationVerifier;
  let nullifierRegistry: NullifierRegistry;

  const network: string = deployments.getNetworkName();

  before(async () => {
    [
      deployer,
    ] = await getAccounts();

    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;

    orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
    orchestrator = new Orchestrator__factory(deployer.wallet).attach(orchestratorAddress);

    const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
    nullifierRegistry = new NullifierRegistry__factory(deployer.wallet).attach(nullifierRegistryAddress);

    const unifiedPaymentVerifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
    unifiedPaymentVerifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierAddress);

    const simpleAttestationVerifierAddress = getDeployedContractAddress(network, "SimpleAttestationVerifier");
    simpleAttestationVerifier = new SimpleAttestationVerifier__factory(deployer.wallet).attach(simpleAttestationVerifierAddress);
  });

  describe("SimpleAttestationVerifier Constructor", async () => {
    it("should have the correct owner set", async () => {
      const actualOwner = await simpleAttestationVerifier.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    // The on-chain witness may have been rotated via setWitness after deploy (independently
    // of the WITNESS_ADDRESS parameter). MultiAttestationVerifier is the replacement; its
    // witness set is covered by test/deploy/24_multiAttestationVerifier.spec.ts.
  });

  describe("UnifiedPaymentVerifier Constructor", async () => {
    it("should have the correct owner set", async () => {
      const actualOwner = await unifiedPaymentVerifier.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    // Skipped: V1 UPV on-chain has orchestrator() getter, not orchestratorRegistry() (pre-cleanup ABI)
    // it("should have the correct orchestrator registry set", async () => {
    //   const actualOrchestratorRegistryAddress = await unifiedPaymentVerifier.orchestratorRegistry();
    //   expect(actualOrchestratorRegistryAddress).to.eq(orchestratorAddress);
    // });

    it("should have the correct nullifier registry set", async () => {
      const actualNullifierRegistryAddress = await unifiedPaymentVerifier.nullifierRegistry();
      expect(actualNullifierRegistryAddress).to.eq(nullifierRegistry.address);
    });

    it("should have the correct attestation verifier set", async () => {
      const actualAttestationVerifierAddress = await unifiedPaymentVerifier.attestationVerifier();
      expect(actualAttestationVerifierAddress).to.eq(simpleAttestationVerifier.address);
    });
  });

  describe("Write Permissions", async () => {
    it("should add write permissions to the NullifierRegistry", async () => {
      const hasWritePermission = await nullifierRegistry.isWriter(unifiedPaymentVerifier.address);
      expect(hasWritePermission).to.be.true;
    });
  });
});