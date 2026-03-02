import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  EscrowV2,
  OrchestratorV2,
  OrchestratorRegistry,
  UnifiedPaymentVerifier,
  NullifierRegistry,
  EscrowRegistry,
} from "../../utils/contracts";
import {
  EscrowV2__factory,
  OrchestratorV2__factory,
  OrchestratorRegistry__factory,
  UnifiedPaymentVerifier__factory,
  NullifierRegistry__factory,
  EscrowRegistry__factory,
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
  ESCROW_V2_INTENT_EXPIRATION_PERIOD,
  ESCROW_V2_MAX_INTENTS_PER_DEPOSIT,
  ESCROW_V2_DUST_THRESHOLD,
  ESCROW_V2_DUST_RECIPIENT,
  ORCHESTRATOR_V2_PROTOCOL_FEE,
  ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("V2 System Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  let escrowV2: EscrowV2;
  let orchestratorV2: OrchestratorV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let unifiedPaymentVerifierV2: UnifiedPaymentVerifier;
  let nullifierRegistry: NullifierRegistry;
  let escrowRegistry: EscrowRegistry;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();

    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;

    const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
    escrowV2 = new EscrowV2__factory(deployer.wallet).attach(escrowV2Address);

    const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
    orchestratorV2 = new OrchestratorV2__factory(deployer.wallet).attach(orchestratorV2Address);

    const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
    orchestratorRegistry = new OrchestratorRegistry__factory(deployer.wallet).attach(orchestratorRegistryAddress);

    const unifiedPaymentVerifierV2Address = getDeployedContractAddress(network, "UnifiedPaymentVerifierV2");
    unifiedPaymentVerifierV2 = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(unifiedPaymentVerifierV2Address);

    const nullifierRegistryAddress = getDeployedContractAddress(network, "NullifierRegistry");
    nullifierRegistry = new NullifierRegistry__factory(deployer.wallet).attach(nullifierRegistryAddress);

    const escrowRegistryAddress = getDeployedContractAddress(network, "EscrowRegistry");
    escrowRegistry = new EscrowRegistry__factory(deployer.wallet).attach(escrowRegistryAddress);
  });

  describe("OrchestratorRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await orchestratorRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have V1 orchestrator registered", async () => {
      const v1Address = getDeployedContractAddress(network, "Orchestrator");
      const isRegistered = await orchestratorRegistry.isOrchestrator(v1Address);
      expect(isRegistered).to.eq(true);
    });

    it("should have V2 orchestrator registered", async () => {
      const isRegistered = await orchestratorRegistry.isOrchestrator(orchestratorV2.address);
      expect(isRegistered).to.eq(true);
    });
  });

  describe("EscrowV2", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await escrowV2.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the correct chain id", async () => {
      const actualChainId = await escrowV2.chainId();
      expect(actualChainId).to.eq((await ethers.provider.getNetwork()).chainId);
    });

    it("should have the correct orchestrator registry", async () => {
      const actualOrchestratorRegistry = await escrowV2.orchestratorRegistry();
      expect(actualOrchestratorRegistry).to.eq(orchestratorRegistry.address);
    });

    it("should have the correct payment verifier registry", async () => {
      const expectedAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
      const actualAddress = await escrowV2.paymentVerifierRegistry();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have the correct dust recipient", async () => {
      const actualDustRecipient = await escrowV2.dustRecipient();
      const expectedDustRecipient = ESCROW_V2_DUST_RECIPIENT[network] != ""
        ? ESCROW_V2_DUST_RECIPIENT[network]
        : deployer.address;
      expect(actualDustRecipient).to.eq(expectedDustRecipient);
    });

    it("should have the correct dust threshold", async () => {
      const actualDustThreshold = await escrowV2.dustThreshold();
      expect(actualDustThreshold).to.eq(ESCROW_V2_DUST_THRESHOLD[network]);
    });

    it("should have the correct max intents per deposit", async () => {
      const actualMaxIntentsPerDeposit = await escrowV2.maxIntentsPerDeposit();
      expect(actualMaxIntentsPerDeposit).to.eq(ESCROW_V2_MAX_INTENTS_PER_DEPOSIT[network]);
    });

    it("should have the correct intent expiration period", async () => {
      const actualIntentExpirationPeriod = await escrowV2.intentExpirationPeriod();
      expect(actualIntentExpirationPeriod).to.eq(ESCROW_V2_INTENT_EXPIRATION_PERIOD[network]);
    });

    it("should be whitelisted in EscrowRegistry", async () => {
      const isWhitelisted = await escrowRegistry.isWhitelistedEscrow(escrowV2.address);
      expect(isWhitelisted).to.eq(true);
    });
  });

  describe("OrchestratorV2", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await orchestratorV2.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the correct chain id", async () => {
      const actualChainId = await orchestratorV2.chainId();
      expect(actualChainId).to.eq((await ethers.provider.getNetwork()).chainId);
    });

    it("should have the correct escrow registry", async () => {
      const expectedAddress = getDeployedContractAddress(network, "EscrowRegistry");
      const actualAddress = await orchestratorV2.escrowRegistry();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have the correct payment verifier registry", async () => {
      const expectedAddress = getDeployedContractAddress(network, "PaymentVerifierRegistry");
      const actualAddress = await orchestratorV2.paymentVerifierRegistry();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have the correct relayer registry", async () => {
      const expectedAddress = getDeployedContractAddress(network, "RelayerRegistry");
      const actualAddress = await orchestratorV2.relayerRegistry();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have the correct protocol fee", async () => {
      const actualProtocolFee = await orchestratorV2.protocolFee();
      expect(actualProtocolFee).to.eq(ORCHESTRATOR_V2_PROTOCOL_FEE[network]);
    });

    it("should have the correct protocol fee recipient", async () => {
      const actualRecipient = await orchestratorV2.protocolFeeRecipient();
      const expectedRecipient = ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network] != ""
        ? ORCHESTRATOR_V2_PROTOCOL_FEE_RECIPIENT[network]
        : deployer.address;
      expect(actualRecipient).to.eq(expectedRecipient);
    });
  });

  describe("UnifiedPaymentVerifierV2", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await unifiedPaymentVerifierV2.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the correct orchestrator registry address", async () => {
      const actualAddress = await unifiedPaymentVerifierV2.orchestratorRegistry();
      expect(actualAddress).to.eq(orchestratorRegistry.address);
    });

    it("should have the correct nullifier registry", async () => {
      const expectedAddress = getDeployedContractAddress(network, "NullifierRegistry");
      const actualAddress = await unifiedPaymentVerifierV2.nullifierRegistry();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have the correct attestation verifier", async () => {
      const expectedAddress = getDeployedContractAddress(network, "SimpleAttestationVerifier");
      const actualAddress = await unifiedPaymentVerifierV2.attestationVerifier();
      expect(actualAddress).to.eq(expectedAddress);
    });

    it("should have write permission on NullifierRegistry", async () => {
      const hasPermission = await nullifierRegistry.isWriter(unifiedPaymentVerifierV2.address);
      expect(hasPermission).to.be.true;
    });
  });
});
