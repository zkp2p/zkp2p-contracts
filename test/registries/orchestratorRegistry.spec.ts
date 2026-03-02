import "module-alias/register";

import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO } from "@utils/constants";
import { OrchestratorRegistry } from "@utils/contracts";

const expect = getWaffleExpect();

describe("OrchestratorRegistry", () => {
  let owner: any;
  let caller: any;
  let orchestrator: any;

  let deployer: DeployHelper;
  let registry: OrchestratorRegistry;

  beforeEach(async () => {
    [owner, caller, orchestrator] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    registry = await deployer.deployOrchestratorRegistry();
  });

  describe("#addOrchestrator", () => {
    let subjectCaller: any;
    let subjectOrchestrator: string;

    async function subject() {
      return registry.connect(subjectCaller.wallet).addOrchestrator(subjectOrchestrator);
    }

    beforeEach(async () => {
      subjectCaller = owner;
      subjectOrchestrator = orchestrator.address;
    });

    it("adds orchestrator and emits event", async () => {
      await expect(subject()).to.emit(registry, "OrchestratorAdded").withArgs(subjectOrchestrator);
      expect(await registry.isOrchestrator(subjectOrchestrator)).to.eq(true);
    });

    describe("when caller is not owner", () => {
      beforeEach(async () => {
        subjectCaller = caller;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when orchestrator is zero address", () => {
      beforeEach(async () => {
        subjectOrchestrator = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(registry, "ZeroAddress");
      });
    });

    describe("when orchestrator is already added", () => {
      beforeEach(async () => {
        await subject();
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(registry, "OrchestratorAlreadyAdded");
      });
    });
  });

  describe("#removeOrchestrator", () => {
    let subjectCaller: any;
    let subjectOrchestrator: string;

    async function subject() {
      return registry.connect(subjectCaller.wallet).removeOrchestrator(subjectOrchestrator);
    }

    beforeEach(async () => {
      subjectCaller = owner;
      subjectOrchestrator = orchestrator.address;
      await registry.connect(owner.wallet).addOrchestrator(subjectOrchestrator);
    });

    it("removes orchestrator and emits event", async () => {
      await expect(subject()).to.emit(registry, "OrchestratorRemoved").withArgs(subjectOrchestrator);
      expect(await registry.isOrchestrator(subjectOrchestrator)).to.eq(false);
    });

    describe("when caller is not owner", () => {
      beforeEach(async () => {
        subjectCaller = caller;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when orchestrator is zero address", () => {
      beforeEach(async () => {
        subjectOrchestrator = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(registry, "ZeroAddress");
      });
    });

    describe("when orchestrator is not currently added", () => {
      beforeEach(async () => {
        await subject();
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(registry, "OrchestratorNotFound");
      });
    });
  });
});
