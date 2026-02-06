import "module-alias/register";
import { ethers } from "hardhat";
import { getWaffleExpect, getAccounts } from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/common";
import {
  DepositRateManagerRegistryV1,
  IDepositRateManagerRegistryV1,
} from "../../typechain";

const expect = getWaffleExpect();

describe("DepositRateManagerRegistryV1", () => {
  // Accounts
  let owner: any;
  let manager: any;
  let other: any;
  let feeRecipient: any;

  // Contract
  let registry: DepositRateManagerRegistryV1;

  // Local helper to create a manager and return id (no double-wait in tests elsewhere)
  async function createRateManagerAndGetId(
    cfg?: Partial<IDepositRateManagerRegistryV1.RateManagerConfigStruct>
  ): Promise<string> {
    const tx = await registry.createRateManager({
      manager: cfg?.manager ?? manager.address,
      feeRecipient: cfg?.feeRecipient ?? feeRecipient.address,
      maxFee: cfg?.maxFee ?? ether(0.05),
      fee: cfg?.fee ?? ether(0.01),
      depositHook: cfg?.depositHook ?? ADDRESS_ZERO,
      name: cfg?.name ?? "name",
      uri: cfg?.uri ?? "uri",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId as string;
  }

  beforeEach(async () => {
    [owner, manager, other, feeRecipient] = await getAccounts();
    registry = (await (
      await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet)
    ).deploy()) as DepositRateManagerRegistryV1;
  });

  describe("#createRateManager", () => {
    let subjectConfig: IDepositRateManagerRegistryV1.RateManagerConfigStruct;

    async function subject() {
      return registry.createRateManager(subjectConfig);
    }

    beforeEach(() => {
      subjectConfig = {
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: ether(0.01),
        depositHook: ADDRESS_ZERO,
        name: "name",
        uri: "uri",
      } as any;
    });

    it("stores config and emits", async () => {
      const tx = await subject();
      const rcpt = await tx.wait();
      const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
      const id = ev?.args?.rateManagerId as string;

      const cfg = await registry.getRateManager(id);
      expect(cfg.manager).to.eq(manager.address);
      expect(cfg.feeRecipient).to.eq(feeRecipient.address);
      expect(cfg.maxFee).to.eq(ether(0.05));
      expect(cfg.fee).to.eq(ether(0.01));
      expect(cfg.depositHook).to.eq(ADDRESS_ZERO);
      expect(cfg.name).to.eq("name");
      expect(cfg.uri).to.eq("uri");
    });

    describe("reverts when manager is zero", () => {
      beforeEach(() => {
        subjectConfig.manager = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid manager");
      });
    });

    describe("reverts when feeRecipient is zero and fee > 0", () => {
      beforeEach(() => {
        subjectConfig.feeRecipient = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid fee recipient");
      });
    });

    describe("reverts when maxFee exceeds global cap", () => {
      beforeEach(() => {
        subjectConfig.maxFee = ether(0.10);
        subjectConfig.fee = ether(0);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max fee exceeds global");
      });
    });

    describe("reverts when fee > maxFee", () => {
      beforeEach(() => {
        subjectConfig.maxFee = ether(0.02);
        subjectConfig.fee = ether(0.03);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee exceeds maxFee");
      });
    });

  });

  describe("#setRateManagerConfig", () => {
    let subjectId: string;
    let subjectManager: string;
    let subjectRecipient: string;
    let subjectHook: string;
    let subjectName: string;
    let subjectUri: string;

    async function subject() {
      return registry
        .connect(manager.wallet)
        .setRateManagerConfig(
          subjectId,
          subjectManager,
          subjectRecipient,
          subjectHook,
          subjectName,
          subjectUri
        );
    }

    beforeEach(async () => {
      subjectId = await createRateManagerAndGetId();
      subjectManager = manager.address;
      subjectRecipient = feeRecipient.address;
      subjectHook = ADDRESS_ZERO;
      subjectName = "n2";
      subjectUri = "u2";
    });

    describe("reverts when caller is not manager", () => {
      it("should revert", async () => {
        await expect(
          registry
            .connect(other.wallet)
            .setRateManagerConfig(
              subjectId,
              subjectManager,
              subjectRecipient,
              subjectHook,
              subjectName,
              subjectUri
            )
        ).to.be.revertedWith("Caller is not manager");
      });
    });

    describe("reverts when newManager is zero", () => {
      beforeEach(() => {
        subjectManager = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid manager");
      });
    });

    it("updates fields", async () => {
      await subject();
      const cfg = await registry.getRateManager(subjectId);
      expect(cfg.manager).to.eq(subjectManager);
      expect(cfg.feeRecipient).to.eq(subjectRecipient);
      expect(cfg.depositHook).to.eq(subjectHook);
      expect(cfg.name).to.eq(subjectName);
      expect(cfg.uri).to.eq(subjectUri);
    });

    describe("reverts when existing fee > 0 and new feeRecipient is zero", () => {
      beforeEach(async () => {
        // set non-zero fee so recipient is required on config updates
        await registry.connect(manager.wallet).setFee(subjectId, ether(0.01));
        subjectRecipient = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid fee recipient");
      });
    });

  });

  describe("#setFee", () => {
    let subjectId: string;
    let subjectFee: any;

    async function subject() {
      return registry.connect(manager.wallet).setFee(subjectId, subjectFee);
    }

    beforeEach(async () => {
      subjectId = await createRateManagerAndGetId();
      subjectFee = ether(0.02);
    });

    describe("#setFee when id not found", () => {
      beforeEach(() => {
        subjectId = ethers.utils.keccak256(
          ethers.utils.toUtf8Bytes("does-not-exist")
        );
        subjectFee = ether(0.01);
      });
      it("reverts when rate manager does not exist", async () => {
        await expect(subject()).to.be.revertedWith("Rate manager does not exist");
      });
    });

    describe("reverts when caller is not manager", () => {
      it("should revert", async () => {
        await expect(
          registry.connect(other.wallet).setFee(subjectId, subjectFee)
        ).to.be.revertedWith("Caller is not manager");
      });
    });

    describe("reverts when fee > maxFee", () => {
      beforeEach(() => {
        subjectFee = ether(0.10);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee exceeds maxFee");
      });
    });

    describe("reverts when fee > 0 and feeRecipient is zero", () => {
      beforeEach(async () => {
        // Create a config with zero recipient allowed (fee must be 0 at creation)
        subjectId = await createRateManagerAndGetId({
          feeRecipient: ADDRESS_ZERO,
          fee: ether(0),
        });
        subjectFee = ether(0.01);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid fee recipient");
      });
    });

    it("updates fee and keeps recipient", async () => {
      await subject();
      const [fee, recipient] = await registry.getFeeAndRecipient(subjectId);
      expect(recipient).to.eq(feeRecipient.address);
      expect(fee).to.eq(ether(0.02));
    });

  });

  describe("#setMinRate", () => {
    let subjectId: string;
    let subjectPM: string;
    let subjectCCY: string;
    let subjectMin: any;

    async function subject() {
      return registry
        .connect(manager.wallet)
        .setMinRate(subjectId, subjectPM as any, subjectCCY as any, subjectMin);
    }

    beforeEach(async () => {
      subjectId = await createRateManagerAndGetId();
      subjectPM = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("pm"));
      subjectCCY = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
      subjectMin = ether(1);
    });

    it("updates pair", async () => {
      await subject();
      expect(
        await registry.getMinRate(subjectId, subjectPM as any, subjectCCY as any)
      ).to.eq(subjectMin);
    });

    describe("reverts when payment method is zero", () => {
      beforeEach(() => {
        subjectPM = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid payment method");
      });
    });

    describe("reverts when currency is zero", () => {
      beforeEach(() => {
        subjectCCY = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid currency");
      });
    });

    describe("reverts when caller is not manager", () => {
      it("should revert", async () => {
        await expect(
          registry
            .connect(other.wallet)
            .setMinRate(subjectId, subjectPM as any, subjectCCY as any, subjectMin)
        ).to.be.revertedWith("Caller is not manager");
      });
    });

  });

  describe("#setMinRatesBatch", () => {
    let subjectId: string;
    let subjectPMs: string[];
    let subjectCCYs: string[][];
    let subjectMins: any[][];

    async function subject() {
      return registry
        .connect(manager.wallet)
        .setMinRatesBatch(
          subjectId,
          subjectPMs as any,
          subjectCCYs as any,
          subjectMins as any
        );
    }

    beforeEach(async () => {
      subjectId = await createRateManagerAndGetId();
      const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("pm"));
      const eur = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("EUR"));
      subjectPMs = [pm];
      subjectCCYs = [[eur]];
      subjectMins = [[ether(2)]];
    });

    it("updates multiple pairs", async () => {
      await subject();
      expect(
        await registry.getMinRate(
          subjectId,
          subjectPMs[0] as any,
          subjectCCYs[0][0] as any
        )
      ).to.eq(subjectMins[0][0]);
    });

    describe("reverts on top-level length mismatch", () => {
      beforeEach(() => {
        subjectPMs = [subjectPMs[0], subjectPMs[0]];
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("reverts when paymentMethods.length != minRatesArr.length", () => {
      beforeEach(() => {
        // Keep currencies aligned with PMs, but change minRates length
        subjectMins = [[ether(2)], [ether(3)]];
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("reverts on inner length mismatch", () => {
      beforeEach(() => {
        subjectMins = [[ether(2), ether(3)]];
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array length mismatch");
      });
    });

    describe("reverts when caller is not manager", () => {
      it("should revert", async () => {
        await expect(
          registry
            .connect(other.wallet)
            .setMinRatesBatch(
              subjectId,
              subjectPMs as any,
              subjectCCYs as any,
              subjectMins as any
            )
        ).to.be.revertedWith("Caller is not manager");
      });
    });

    describe("reverts when any payment method is zero", () => {
      beforeEach(() => {
        subjectPMs = [ethers.constants.HashZero];
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid payment method");
      });
    });

    describe("reverts when any currency is zero", () => {
      beforeEach(() => {
        subjectCCYs = [[ethers.constants.HashZero]];
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid currency");
      });
    });
  });
});
