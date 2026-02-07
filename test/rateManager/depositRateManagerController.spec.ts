import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

import {
  DepositRateManagerController,
  DepositRateManagerRegistryV1,
  Escrow,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerDepositHookMock,
  USDCMock,
  IDepositRateManagerRegistryV1,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("DepositRateManagerController", () => {
  // Accounts
  let owner: any;
  let depositor: any;
  let manager: any;
  let managerFeeRecipient: any;
  let other: any;

  // Contracts
  let escrow: Escrow;
  let controller: DepositRateManagerController;
  let registry: DepositRateManagerRegistryV1;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let usdcToken: USDCMock;
  let hook: RateManagerDepositHookMock;

  // Common values
  let paymentMethod: BytesLike;
  let payeeDetailsHash: BytesLike;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [owner, depositor, manager, managerFeeRecipient, other] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(10_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    escrow = await deployer.deployEscrow(
      owner.address,
      ethers.BigNumber.from(1),
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      ethers.BigNumber.from(10),
      ethers.BigNumber.from(3600)
    );

    verifier = await deployer.deployPaymentVerifierMock();
    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD, Currency.EUR]);

    registry = await deployer.deployDepositRateManagerRegistryV1();
    controller = await deployer.deployDepositRateManagerController();
    hook = await deployer.deployRateManagerDepositHookMock();

    payeeDetailsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
  });

  async function createRateManagerAndGetId(
    reg: DepositRateManagerRegistryV1,
    cfg: IDepositRateManagerRegistryV1.RateManagerConfigStruct
  ): Promise<string> {
    const tx = await reg.createRateManager(cfg);
    const receipt = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }

  async function seedDeposit(minRate: BigNumber) {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payeeDetailsHash, data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  async function setRawDepositManagerConfig(params: { escrowAddress: string; depositId: number; registryAddress: string; rateManagerId: BytesLike }) {
    const outerSlot = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [params.escrowAddress, 0])
    );
    const entrySlot = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(["uint256", "bytes32"], [params.depositId, outerSlot])
    );
    await ethers.provider.send("hardhat_setStorageAt", [
      controller.address,
      entrySlot,
      ethers.utils.hexZeroPad(params.registryAddress, 32),
    ]);
    const rateManagerSlot = ethers.BigNumber.from(entrySlot).add(1).toHexString();
    await ethers.provider.send("hardhat_setStorageAt", [
      controller.address,
      rateManagerSlot,
      ethers.utils.hexZeroPad(ethers.utils.hexlify(params.rateManagerId), 32),
    ]);
  }

  describe("#setDepositRateManager", () => {
    let subjectEscrow: string;
    let subjectDepositId: number;
    let subjectRegistry: string;
    let subjectRateManagerId: BytesLike;
    let subjectCaller: any;

    async function subject() {
      return controller.connect(subjectCaller.wallet).setDepositRateManager(
        subjectEscrow,
        subjectDepositId,
        subjectRegistry,
        subjectRateManagerId
      );
    }

    beforeEach(async () => {
      await seedDeposit(ether(1));
      subjectEscrow = escrow.address;
      subjectDepositId = 0;
      subjectRegistry = registry.address;
      subjectCaller = depositor;
      subjectRateManagerId = await createRateManagerAndGetId(registry, {
        manager: manager.address,
        feeRecipient: managerFeeRecipient.address,
        maxFee: ether(0.05),
        fee: 0,
        depositHook: hook.address,
        name: "n",
        uri: "u",
      });
    });

    it("emits and stores rate manager config; hook is invoked", async () => {
      await expect(subject())
        .to.emit(controller, "DepositRateManagerSet")
        .withArgs(subjectEscrow, subjectDepositId, subjectRegistry, subjectRateManagerId);

      const stored = await controller.getDepositRateManager(subjectEscrow, subjectDepositId);
      expect(stored.registry).to.eq(subjectRegistry);
      expect(stored.rateManagerId).to.eq(subjectRateManagerId);
    });

    describe("when hook fails", () => {
      beforeEach(async () => {
        await hook.setShouldRevert(true);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Hook: revert on opt-in");
      });
    });

    describe("when escrow is paused", () => {
      beforeEach(async () => {
        await escrow.connect(owner.wallet).pauseEscrow();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = manager;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "UnauthorizedCaller");
      });
    });

    describe("when rateManagerId is zero", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroValue");
      });
    });

    describe("when registry is zero address", () => {
      beforeEach(async () => {
        subjectRegistry = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroAddress");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroAddress");
      });
    });

    describe("when rateManagerId not found in registry", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("does-not-exist"));
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "RateManagerNotFound");
      });
    });

    describe("when manager already set", () => {
      beforeEach(async () => {
        await controller.connect(depositor.wallet).setDepositRateManager(subjectEscrow, subjectDepositId, subjectRegistry, subjectRateManagerId);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "RateManagerAlreadySet");
      });
    });
  });

  describe("#clearDepositRateManager", () => {
    let subjectEscrow: string;
    let subjectDepositId: number;
    let subjectCaller: any;
    let storedRateManagerId: string;

    async function subject() {
      return controller.connect(subjectCaller.wallet).clearDepositRateManager(subjectEscrow, subjectDepositId);
    }

    beforeEach(async () => {
      await seedDeposit(ether(1));

      storedRateManagerId = await createRateManagerAndGetId(registry, {
        manager: manager.address,
        feeRecipient: managerFeeRecipient.address,
        maxFee: ether(0.05),
        fee: 0,
        depositHook: ADDRESS_ZERO,
        name: "n",
        uri: "u",
      });
      await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, storedRateManagerId);

      subjectEscrow = escrow.address;
      subjectDepositId = 0;
      subjectCaller = depositor;
    });

    it("clears config and emits", async () => {
      await expect(subject())
        .to.emit(controller, "DepositRateManagerCleared")
        .withArgs(subjectEscrow, subjectDepositId, registry.address, storedRateManagerId);

      const stored = await controller.getDepositRateManager(subjectEscrow, subjectDepositId);
      expect(stored.registry).to.eq(ADDRESS_ZERO);
      expect(stored.rateManagerId).to.eq(ethers.constants.HashZero);
    });

    describe("when escrow is paused", () => {
      beforeEach(async () => {
        await escrow.connect(owner.wallet).pauseEscrow();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroAddress");
      });
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "UnauthorizedCaller");
      });
    });
  });

  describe("#getEffectiveMinRate", () => {
    let subjectDepositId: number;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrency: BytesLike;

    async function subject() {
      return controller.getEffectiveMinRate(escrow.address, subjectDepositId, subjectPaymentMethod, subjectCurrency);
    }

    beforeEach(async () => {
      await seedDeposit(ether(1));
      subjectDepositId = 0;
      subjectPaymentMethod = paymentMethod;
      subjectCurrency = Currency.USD;
    });

    it("returns depositor floor when no manager is set", async () => {
      expect(await subject()).to.eq(ether(1));
    });

    describe("when manager min > floor", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.05));
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
      });

      it("returns manager min", async () => {
        expect(await subject()).to.eq(ether(1.05));
      });
    });

    describe("when manager min < floor", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(0.9));
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
      });

      it("returns depositor floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
    });

    describe("when manager disables pair", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ZERO);
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
      });

      it("returns 0", async () => {
        expect(await subject()).to.eq(ZERO);
      });
    });

    describe("when payment method inactive", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.1));
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
        await escrow.connect(depositor.wallet).setPaymentMethodActive(0, paymentMethod, false);
      });

      it("returns 0", async () => {
        expect(await subject()).to.eq(ZERO);
      });
    });

    describe("when manager enables unlisted currency", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.EUR, ether(1.2));
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
        subjectCurrency = Currency.EUR;
      });

      it("returns manager min", async () => {
        expect(await subject()).to.eq(ether(1.2));
      });
    });

    describe("when registry is not set", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await setRawDepositManagerConfig({
          escrowAddress: escrow.address,
          depositId: subjectDepositId,
          registryAddress: ADDRESS_ZERO,
          rateManagerId,
        });
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "RateManagerRegistryNotSet");
      });
    });
  });

  describe("#getManagerFee", () => {
    let subjectDepositId: number;

    async function subject() {
      return controller.getManagerFee(escrow.address, subjectDepositId);
    }

    beforeEach(async () => {
      await seedDeposit(ether(1));
      subjectDepositId = 0;
    });

    it("returns zero when no manager is set", async () => {
      const result = await subject();
      expect(result.recipient).to.eq(ADDRESS_ZERO);
      expect(result.fee).to.eq(ZERO);
    });

    describe("when manager is set", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: ether(0.01),
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
      });

      it("returns registry fee and recipient", async () => {
        const result = await subject();
        expect(result.recipient).to.eq(managerFeeRecipient.address);
        expect(result.fee).to.eq(ether(0.01));
      });
    });

    describe("when registry is not set", () => {
      beforeEach(async () => {
        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: ether(0.01),
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await setRawDepositManagerConfig({
          escrowAddress: escrow.address,
          depositId: subjectDepositId,
          registryAddress: ADDRESS_ZERO,
          rateManagerId,
        });
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "RateManagerRegistryNotSet");
      });
    });
  });
});
