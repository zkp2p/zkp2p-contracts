import "module-alias/register";

import { deployments, ethers } from "hardhat";

import {
  AcrossBridgeHook__factory,
  Orchestrator__factory,
  ProtocolViewer__factory,
  UnifiedPaymentVerifier__factory,
  WhitelistPreIntentHook__factory,
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
} from "../../deployments/parameters";

const expect = getWaffleExpect();

describe("Orchestrator and WhitelistPreIntentHook Deployment", () => {
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

  describe("Orchestrator", () => {
    it("should have the correct owner", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const orchestrator = new Orchestrator__factory(deployer.wallet).attach(orchestratorAddress);

      expect(await orchestrator.owner()).to.eq(multiSig);
    });

    it("should have the correct deposit rate manager controller set", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const orchestrator = new Orchestrator__factory(deployer.wallet).attach(orchestratorAddress);
      const controllerAddress = getDeployedContractAddress(network, "DepositRateManagerController");

      expect(await orchestrator.depositRateManagerController()).to.eq(controllerAddress);
    });

    it("should be wired to the Escrow", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const escrowAddress = getDeployedContractAddress(network, "Escrow");
      const escrow = await ethers.getContractAt("Escrow", escrowAddress);

      expect(await escrow.orchestrator()).to.eq(orchestratorAddress);
    });
  });

  describe("UnifiedPaymentVerifier", () => {
    it("should trust the new Orchestrator", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const verifierAddress = getDeployedContractAddress(network, "UnifiedPaymentVerifier");
      const verifier = new UnifiedPaymentVerifier__factory(deployer.wallet).attach(verifierAddress);

      expect(await verifier.orchestrator()).to.eq(orchestratorAddress);
    });
  });

  describe("AcrossBridgeHook", () => {
    it("should trust the new Orchestrator", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const hookAddress = getDeployedContractAddress(network, "AcrossBridgeHook");
      const hook = new AcrossBridgeHook__factory(deployer.wallet).attach(hookAddress);

      expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    });
  });

  describe("WhitelistPreIntentHook", () => {
    it("should be deployed", async () => {
      const hookAddress = getDeployedContractAddress(network, "WhitelistPreIntentHook");
      expect(hookAddress).to.not.eq(ethers.constants.AddressZero);
      expect(await ethers.provider.getCode(hookAddress)).to.not.eq("0x");
    });

    it("should have the correct Orchestrator set", async () => {
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");
      const hookAddress = getDeployedContractAddress(network, "WhitelistPreIntentHook");
      const hook = new WhitelistPreIntentHook__factory(deployer.wallet).attach(hookAddress);

      expect(await hook.orchestrator()).to.eq(orchestratorAddress);
    });
  });

  describe("ProtocolViewer", () => {
    it("should have the correct owner", async () => {
      const viewerAddress = getDeployedContractAddress(network, "ProtocolViewer");
      const viewer = new ProtocolViewer__factory(deployer.wallet).attach(viewerAddress);

      expect(await viewer.owner()).to.eq(multiSig);
    });

    it("should reference the correct Escrow and Orchestrator", async () => {
      const viewerAddress = getDeployedContractAddress(network, "ProtocolViewer");
      const viewer = new ProtocolViewer__factory(deployer.wallet).attach(viewerAddress);
      const escrowAddress = getDeployedContractAddress(network, "Escrow");
      const orchestratorAddress = getDeployedContractAddress(network, "Orchestrator");

      expect(await viewer.escrowContract()).to.eq(escrowAddress);
      expect(await viewer.orchestrator()).to.eq(orchestratorAddress);
    });
  });
});
