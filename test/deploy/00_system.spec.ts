import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  Escrow,
  NullifierRegistry,
} from "../../utils/contracts";
import {
  ChainlinkOracleAdapter,
  Escrow__factory,
  NullifierRegistry__factory,
  Orchestrator__factory,
  PaymentVerifierRegistry,
  PaymentVerifierRegistry__factory,
  PostIntentHookRegistry,
  PostIntentHookRegistry__factory,
  ProtocolViewer,
  ProtocolViewer__factory,
  RelayerRegistry,
  RelayerRegistry__factory,
  Orchestrator,
  DepositRateManagerController,
  DepositRateManagerController__factory,
  ManualRateManagerRegistry,
  ManualRateManagerRegistry__factory,
  OracleRateManagerRegistry,
  OracleRateManagerRegistry__factory,
  ChainlinkOracleAdapter__factory,
  EscrowRegistry__factory,
  EscrowRegistry
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
  INTENT_EXPIRATION_PERIOD,
  PROTOCOL_TAKER_FEE,
  PROTOCOL_TAKER_FEE_RECIPIENT,
  MULTI_SIG,
  ESCROW_DUST_RECIPIENT,
  ESCROW_DUST_THRESHOLD,
  MAX_INTENTS_PER_DEPOSIT
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("V2.1 System Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let nullifierRegistry: NullifierRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let protocolViewer: ProtocolViewer;
  let escrowRegistry: EscrowRegistry;
  let depositRateManagerController: DepositRateManagerController;
  let manualRateManagerRegistry: ManualRateManagerRegistry;
  let oracleRateManagerRegistry: OracleRateManagerRegistry;
  let chainlinkOracleAdapter: ChainlinkOracleAdapter;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [
      deployer,
    ] = await getAccounts();

    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;

    const escrowAddress = await getDeployedContractAddress(network, "Escrow");
    escrow = new Escrow__factory(deployer.wallet).attach(escrowAddress);

    const orchestratorAddress = await getDeployedContractAddress(network, "Orchestrator");
    orchestrator = new Orchestrator__factory(deployer.wallet).attach(orchestratorAddress);

    const paymentVerifierRegistryAddress = await getDeployedContractAddress(network, "PaymentVerifierRegistry");
    paymentVerifierRegistry = new PaymentVerifierRegistry__factory(deployer.wallet).attach(paymentVerifierRegistryAddress);

    const postIntentHookRegistryAddress = await getDeployedContractAddress(network, "PostIntentHookRegistry");
    postIntentHookRegistry = new PostIntentHookRegistry__factory(deployer.wallet).attach(postIntentHookRegistryAddress);

    const relayerRegistryAddress = await getDeployedContractAddress(network, "RelayerRegistry");
    relayerRegistry = new RelayerRegistry__factory(deployer.wallet).attach(relayerRegistryAddress);

    const nullifierRegistryAddress = await getDeployedContractAddress(network, "NullifierRegistry");
    nullifierRegistry = new NullifierRegistry__factory(deployer.wallet).attach(nullifierRegistryAddress);

    const escrowRegistryAddress = await getDeployedContractAddress(network, "EscrowRegistry");
    escrowRegistry = new EscrowRegistry__factory(deployer.wallet).attach(escrowRegistryAddress);

    const protocolViewerAddress = await getDeployedContractAddress(network, "ProtocolViewer");
    protocolViewer = new ProtocolViewer__factory(deployer.wallet).attach(protocolViewerAddress);

    const depositRateManagerControllerAddress = await getDeployedContractAddress(network, "DepositRateManagerController");
    depositRateManagerController = new DepositRateManagerController__factory(deployer.wallet).attach(depositRateManagerControllerAddress);

    const manualRateManagerRegistryAddress = await getDeployedContractAddress(network, "ManualRateManagerRegistry");
    manualRateManagerRegistry = new ManualRateManagerRegistry__factory(deployer.wallet).attach(manualRateManagerRegistryAddress);

    const oracleRateManagerRegistryAddress = await getDeployedContractAddress(network, "OracleRateManagerRegistry");
    oracleRateManagerRegistry = new OracleRateManagerRegistry__factory(deployer.wallet).attach(oracleRateManagerRegistryAddress);

    const chainlinkOracleAdapterAddress = await getDeployedContractAddress(network, "ChainlinkOracleAdapter");
    chainlinkOracleAdapter = new ChainlinkOracleAdapter__factory(deployer.wallet).attach(chainlinkOracleAdapterAddress);
  });

  describe("EscrowRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await escrowRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("Escrow", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await escrow.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the payment verifier registry set", async () => {
      const actualPaymentVerifierRegistry = await escrow.paymentVerifierRegistry();
      expect(actualPaymentVerifierRegistry).to.eq(paymentVerifierRegistry.address);
    });

    it("should have the correct orchestrator set", async () => {
      const actualOrchestrator = await escrow.orchestrator();
      expect(actualOrchestrator).to.eq(orchestrator.address);
    });

    it("should have the correct chain id set", async () => {
      const actualChainId = await escrow.chainId();
      expect(actualChainId).to.eq((await ethers.provider.getNetwork()).chainId);
    });

    it("should have the escrow whitelisted", async () => {
      const isWhitelisted = await escrowRegistry.isWhitelistedEscrow(escrow.address);
      expect(isWhitelisted).to.eq(true);
    });

    it("should have the correct dust recipient set", async () => {
      const actualDustRecipient = await escrow.dustRecipient();

      const expectedDustRecipient = ESCROW_DUST_RECIPIENT[network] != ""
        ? ESCROW_DUST_RECIPIENT[network]
        : deployer.address;

      expect(actualDustRecipient).to.eq(expectedDustRecipient);
    });

    it("should have the correct dust threshold set", async () => {
      const actualDustThreshold = await escrow.dustThreshold();
      expect(actualDustThreshold).to.eq(ESCROW_DUST_THRESHOLD[network]);
    });

    it("should have the correct max intents per deposit set", async () => {
      const actualMaxIntentsPerDeposit = await escrow.maxIntentsPerDeposit();
      expect(actualMaxIntentsPerDeposit).to.eq(MAX_INTENTS_PER_DEPOSIT[network]);
    });

    it("should have the correct intent expiration period set", async () => {
      const actualIntentExpirationPeriod = await escrow.intentExpirationPeriod();
      expect(actualIntentExpirationPeriod).to.eq(INTENT_EXPIRATION_PERIOD[network]);
    });
  });

  describe("Orchestrator", async () => {
    it("should have the correct owner set", async () => {
      const actualOwner = await orchestrator.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the correct chainId set", async () => {
      const actualChainId = await orchestrator.chainId();
      expect(actualChainId).to.eq((await ethers.provider.getNetwork()).chainId);
    });

    it("should have the correct protocol fee and recipient set", async () => {
      const actualProtocolFee = await orchestrator.protocolFee();
      const actualProtocolFeeRecipient = await orchestrator.protocolFeeRecipient();

      const expectedProtocolFeeRecipient = PROTOCOL_TAKER_FEE_RECIPIENT[network] != ""
        ? PROTOCOL_TAKER_FEE_RECIPIENT[network]
        : deployer.address;

      expect(actualProtocolFee).to.eq(PROTOCOL_TAKER_FEE[network]);
      expect(actualProtocolFeeRecipient).to.eq(expectedProtocolFeeRecipient);
    });

    it("should have the correct post intent hook registry set", async () => {
      const actualPostIntentHookRegistry = await orchestrator.postIntentHookRegistry();
      expect(actualPostIntentHookRegistry).to.eq(postIntentHookRegistry.address);
    });

    it("should have the correct relayer registry set", async () => {
      const actualRelayerRegistry = await orchestrator.relayerRegistry();
      expect(actualRelayerRegistry).to.eq(relayerRegistry.address);
    });

    it("should have the correct escrow registry set", async () => {
      const actualEscrowRegistry = await orchestrator.escrowRegistry();
      expect(actualEscrowRegistry).to.eq(escrowRegistry.address);
    });

    it("should have the deposit rate manager controller set", async () => {
      const actualController = await orchestrator.depositRateManagerController();
      expect(actualController).to.eq(depositRateManagerController.address);
    });
  });

  describe("NullifierRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await nullifierRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("PaymentVerifierRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await paymentVerifierRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("PostIntentHookRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await postIntentHookRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("RelayerRegistry", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await relayerRegistry.owner();
      expect(actualOwner).to.eq(multiSig);
    });
  });

  describe("ProtocolViewer", async () => {
    it("should have the correct owner", async () => {
      const actualOwner = await protocolViewer.owner();
      expect(actualOwner).to.eq(multiSig);
    });

    it("should have the correct escrow and orchestrator set", async () => {
      const actualEscrow = await protocolViewer.escrowContract();
      const actualOrchestrator = await protocolViewer.orchestrator();
      expect(actualEscrow).to.eq(escrow.address);
      expect(actualOrchestrator).to.eq(orchestrator.address);
    });
  });

  describe("Deposit Rate Manager Registries + Adapters", async () => {
    it("should have deployed ManualRateManagerRegistry", async () => {
      expect(manualRateManagerRegistry.address).to.not.eq(ethers.constants.AddressZero);
      expect(await ethers.provider.getCode(manualRateManagerRegistry.address)).to.not.eq("0x");
    });

    it("should have deployed OracleRateManagerRegistry", async () => {
      expect(oracleRateManagerRegistry.address).to.not.eq(ethers.constants.AddressZero);
      expect(await ethers.provider.getCode(oracleRateManagerRegistry.address)).to.not.eq("0x");
    });

    it("should have deployed ChainlinkOracleAdapter", async () => {
      expect(chainlinkOracleAdapter.address).to.not.eq(ethers.constants.AddressZero);
      expect(await ethers.provider.getCode(chainlinkOracleAdapter.address)).to.not.eq("0x");
    });
  });
});
