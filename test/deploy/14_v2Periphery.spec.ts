import "module-alias/register";

import { deployments } from "hardhat";

import {
  AcrossBridgeHookV2__factory,
  WhitelistPreIntentHook__factory,
  SignatureGatingPreIntentHook__factory,
  RateManagerV1__factory,
  ProtocolViewer__factory,
  PostIntentHookRegistry__factory,
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
  ACROSS_SPOKE_POOL,
  MULTI_SIG,
  USDC,
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("V2 Periphery Deployment", () => {
  let deployer: Account;
  let multiSig: Address;

  const network: string = deployments.getNetworkName();

  function getDeployedContractAddress(network: string, contractName: string): string {
    return require(`../../deployments/${network}/${contractName}.json`).address;
  }

  before(async () => {
    [deployer] = await getAccounts();
    multiSig = MULTI_SIG[network] ? MULTI_SIG[network] : deployer.address;
  });

  describe("WhitelistPreIntentHook", async () => {
    it("should have the correct orchestrator registry address", async () => {
      const hookAddress = getDeployedContractAddress(network, "WhitelistPreIntentHook");
      const hook = new WhitelistPreIntentHook__factory(deployer.wallet).attach(hookAddress);

      const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
      expect(await hook.orchestratorRegistry()).to.eq(orchestratorRegistryAddress);
    });
  });

  describe("SignatureGatingPreIntentHook", async () => {
    it("should have the correct orchestrator registry address", async () => {
      const hookAddress = getDeployedContractAddress(network, "SignatureGatingPreIntentHook");
      const hook = new SignatureGatingPreIntentHook__factory(deployer.wallet).attach(hookAddress);

      const orchestratorRegistryAddress = getDeployedContractAddress(network, "OrchestratorRegistry");
      expect(await hook.orchestratorRegistry()).to.eq(orchestratorRegistryAddress);
    });

    it("should have the correct chain id", async () => {
      const hookAddress = getDeployedContractAddress(network, "SignatureGatingPreIntentHook");
      const hook = new SignatureGatingPreIntentHook__factory(deployer.wallet).attach(hookAddress);

      const { ethers } = require("hardhat");
      const expectedChainId = (await ethers.provider.getNetwork()).chainId;
      expect(await hook.chainId()).to.eq(expectedChainId);
    });
  });

  describe("AcrossBridgeHookV2", async () => {
    it("should have the correct orchestrator", async () => {
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
      const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

      const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
      expect(await hook.orchestrator()).to.eq(orchestratorV2Address);
    });

    it("should have the correct input token", async () => {
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
      const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

      const usdcAddress = USDC[network]
        ? USDC[network]
        : getDeployedContractAddress(network, "USDCMock");
      expect(await hook.inputToken()).to.eq(usdcAddress);
    });

    it("should have the correct spoke pool", async () => {
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
      const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

      const configuredSpokePool = ACROSS_SPOKE_POOL[network];
      const spokePoolAddress = configuredSpokePool && configuredSpokePool !== ""
        ? configuredSpokePool
        : getDeployedContractAddress(network, "AcrossSpokePoolMock");
      expect(await hook.spokePool()).to.eq(spokePoolAddress);
    });

    it("should have the correct owner", async () => {
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
      const hook = new AcrossBridgeHookV2__factory(deployer.wallet).attach(hookAddress);

      expect(await hook.owner()).to.eq(multiSig);
    });

    it("should be whitelisted in PostIntentHookRegistry", async () => {
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHookV2");
      const registryAddress = getDeployedContractAddress(network, "PostIntentHookRegistry");
      const registry = new PostIntentHookRegistry__factory(deployer.wallet).attach(registryAddress);

      expect(await registry.isWhitelistedHook(hookAddress)).to.eq(true);
    });
  });

  describe("RateManagerV1", async () => {
    it("should be deployed", async () => {
      const address = getDeployedContractAddress(network, "RateManagerV1");
      expect(address).to.not.eq("0x0000000000000000000000000000000000000000");
    });
  });

  describe("ChainlinkOracleAdapter", async () => {
    it("should be deployed", async () => {
      const address = getDeployedContractAddress(network, "ChainlinkOracleAdapter");
      expect(address).to.not.eq("0x0000000000000000000000000000000000000000");
    });
  });

  describe("ProtocolViewerV2", async () => {
    it("should have the correct escrow contract", async () => {
      const viewerAddress = getDeployedContractAddress(network, "ProtocolViewerV2");
      const viewer = new ProtocolViewer__factory(deployer.wallet).attach(viewerAddress);

      const escrowV2Address = getDeployedContractAddress(network, "EscrowV2");
      expect(await viewer.escrowContract()).to.eq(escrowV2Address);
    });

    it("should have the correct orchestrator", async () => {
      const viewerAddress = getDeployedContractAddress(network, "ProtocolViewerV2");
      const viewer = new ProtocolViewer__factory(deployer.wallet).attach(viewerAddress);

      const orchestratorV2Address = getDeployedContractAddress(network, "OrchestratorV2");
      expect(await viewer.orchestrator()).to.eq(orchestratorV2Address);
    });

    it("should have the correct owner", async () => {
      const viewerAddress = getDeployedContractAddress(network, "ProtocolViewerV2");
      const viewer = new ProtocolViewer__factory(deployer.wallet).attach(viewerAddress);

      expect(await viewer.owner()).to.eq(multiSig);
    });
  });
});
