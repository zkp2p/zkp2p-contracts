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
  ManualRateManagerRegistry,
  Escrow,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerDepositHookMock,
  USDCMock,
  IBaseRateManagerRegistry,
} from "@utils/contracts";
import { AggregatorV3Mock, ChainlinkOracleAdapter, RevertingOracleAdapterMock, StaticOracleAdapterMock } from "../../typechain";

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
  let registry: ManualRateManagerRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let usdcToken: USDCMock;
  let hook: RateManagerDepositHookMock;
  let chainlinkAdapter: ChainlinkOracleAdapter;
  let staticAdapter: StaticOracleAdapterMock;
  let revertingAdapter: RevertingOracleAdapterMock;

  // Common values
  let paymentMethod: BytesLike;
  let payeeDetailsHash: BytesLike;

  function encodeChainlinkRawConfig(feed: string, invert: boolean): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "bool"], [feed, invert]);
  }

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

    registry = await deployer.deployManualRateManagerRegistry();
    controller = await deployer.deployDepositRateManagerController();
    hook = await deployer.deployRateManagerDepositHookMock();
    chainlinkAdapter = (await (
      await ethers.getContractFactory("ChainlinkOracleAdapter", owner.wallet)
    ).deploy()) as ChainlinkOracleAdapter;
    staticAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    payeeDetailsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
  });

  async function createRateManagerAndGetId(
    reg: ManualRateManagerRegistry,
    cfg: IBaseRateManagerRegistry.RateManagerConfigStruct
  ): Promise<string> {
    const tx = await reg.createRateManager(cfg);
    const receipt = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }

  async function seedDeposit(minRate: BigNumber, delegateAddress: string = ADDRESS_ZERO) {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payeeDetailsHash, data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: delegateAddress,
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

    describe("when no rate manager is set", () => {
      beforeEach(async () => {
        // Clear existing delegation first
        await controller.connect(depositor.wallet).clearDepositRateManager(escrow.address, 0);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "RateManagerNotFound");
      });
    });
  });

  describe("#setDepositOracleFloorConfig", () => {
    let subjectEscrow: string;
    let subjectDepositId: number;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectAdapter: string;
    let subjectRawAdapterConfig: string;
    let subjectSpreadBps: number;
    let subjectMaxStaleness: number;
    let subjectCaller: any;

    async function subject() {
      return controller.connect(subjectCaller.wallet).setDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode,
        subjectAdapter,
        subjectRawAdapterConfig,
        subjectSpreadBps,
        subjectMaxStaleness
      );
    }

    beforeEach(async () => {
      await seedDeposit(ether(1), manager.address);

      const feed = (await (
        await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
      ).deploy(8, 100_000_000)) as AggregatorV3Mock;

      subjectEscrow = escrow.address;
      subjectDepositId = 0;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      subjectAdapter = chainlinkAdapter.address;
      subjectRawAdapterConfig = encodeChainlinkRawConfig(feed.address, false);
      subjectSpreadBps = 100;
      subjectMaxStaleness = 3600;
      subjectCaller = depositor;
    });

    it("stores oracle floor config and emits event", async () => {
      const normalizedAdapterConfig = await chainlinkAdapter.validateConfig(subjectRawAdapterConfig);

      await expect(subject())
        .to.emit(controller, "DepositOracleFloorConfigUpdated")
        .withArgs(
          subjectEscrow,
          subjectDepositId,
          subjectPaymentMethod,
          subjectCurrencyCode,
          subjectAdapter,
          subjectSpreadBps,
          subjectMaxStaleness,
          normalizedAdapterConfig
        );

      const stored = await controller.getDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode
      );
      expect(stored.isConfigured).to.eq(true);
      expect(stored.adapter).to.eq(subjectAdapter);
      expect(stored.spreadBps).to.eq(subjectSpreadBps);
      expect(stored.maxStaleness).to.eq(subjectMaxStaleness);
      expect(stored.adapterConfig).to.eq(normalizedAdapterConfig);
    });

    describe("when caller is the delegate", () => {
      beforeEach(async () => {
        subjectCaller = manager;
      });

      it("sets oracle floor config", async () => {
        await subject();
        const stored = await controller.getDepositOracleFloorConfig(
          subjectEscrow,
          subjectDepositId,
          subjectPaymentMethod,
          subjectCurrencyCode
        );
        expect(stored.isConfigured).to.eq(true);
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

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroAddress");
      });
    });

    describe("when caller is not depositor or delegate", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidPaymentMethod");
      });
    });

    describe("when currency is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidCurrency");
      });
    });

    describe("when adapter is zero address", () => {
      beforeEach(async () => {
        subjectAdapter = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidAdapter");
      });
    });

    describe("when adapter is not a contract", () => {
      beforeEach(async () => {
        subjectAdapter = other.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidAdapter");
      });
    });

    describe("when spread is above bps limit", () => {
      beforeEach(async () => {
        subjectSpreadBps = 10_001;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidSpread");
      });
    });

    describe("when max staleness is zero", () => {
      beforeEach(async () => {
        subjectMaxStaleness = 0;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidStaleness");
      });
    });

    describe("when normalized adapter config is too long", () => {
      beforeEach(async () => {
        subjectAdapter = staticAdapter.address;
        subjectRawAdapterConfig = `0x${"11".repeat(257)}`;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidAdapterConfig");
      });
    });
  });

  describe("#setDepositOracleFloorConfigs", () => {
    let subjectEscrow: string;
    let subjectDepositId: number;
    let subjectOracleFloorConfigs: {
      paymentMethod: BytesLike;
      currencyCode: BytesLike;
      adapter: string;
      rawAdapterConfig: string;
      spreadBps: number;
      maxStaleness: number;
    }[];
    let subjectCaller: any;

    async function subject() {
      return controller.connect(subjectCaller.wallet).setDepositOracleFloorConfigs(
        subjectEscrow,
        subjectDepositId,
        subjectOracleFloorConfigs
      );
    }

    beforeEach(async () => {
      await seedDeposit(ether(1), manager.address);

      const usdFeed = (await (
        await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
      ).deploy(8, 100_000_000)) as AggregatorV3Mock;
      const eurFeed = (await (
        await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
      ).deploy(8, 110_000_000)) as AggregatorV3Mock;

      subjectEscrow = escrow.address;
      subjectDepositId = 0;
      subjectCaller = depositor;
      subjectOracleFloorConfigs = [
        {
          paymentMethod,
          currencyCode: Currency.USD,
          adapter: chainlinkAdapter.address,
          rawAdapterConfig: encodeChainlinkRawConfig(usdFeed.address, false),
          spreadBps: 100,
          maxStaleness: 3600,
        },
        {
          paymentMethod,
          currencyCode: Currency.EUR,
          adapter: chainlinkAdapter.address,
          rawAdapterConfig: encodeChainlinkRawConfig(eurFeed.address, false),
          spreadBps: 150,
          maxStaleness: 7200,
        },
      ];
    });

    it("sets multiple oracle floor configs", async () => {
      await subject();

      const usdConfig = await controller.getDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        paymentMethod,
        Currency.USD
      );
      expect(usdConfig.isConfigured).to.eq(true);
      expect(usdConfig.spreadBps).to.eq(100);

      const eurConfig = await controller.getDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        paymentMethod,
        Currency.EUR
      );
      expect(eurConfig.isConfigured).to.eq(true);
      expect(eurConfig.spreadBps).to.eq(150);
    });

    describe("when caller is the delegate", () => {
      beforeEach(async () => {
        subjectCaller = manager;
      });

      it("sets multiple oracle floor configs", async () => {
        await subject();
        const usdConfig = await controller.getDepositOracleFloorConfig(
          subjectEscrow,
          subjectDepositId,
          paymentMethod,
          Currency.USD
        );
        expect(usdConfig.isConfigured).to.eq(true);
      });
    });

    describe("when caller is unauthorized", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "UnauthorizedCallerOrDelegate");
      });
    });
  });

  describe("#clearDepositOracleFloorConfig", () => {
    let subjectEscrow: string;
    let subjectDepositId: number;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectCaller: any;

    async function subject() {
      return controller.connect(subjectCaller.wallet).clearDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode
      );
    }

    beforeEach(async () => {
      await seedDeposit(ether(1), manager.address);
      const feed = (await (
        await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
      ).deploy(8, 100_000_000)) as AggregatorV3Mock;
      await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
        escrow.address,
        0,
        paymentMethod,
        Currency.USD,
        chainlinkAdapter.address,
        encodeChainlinkRawConfig(feed.address, false),
        100,
        3600
      );

      subjectEscrow = escrow.address;
      subjectDepositId = 0;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      subjectCaller = depositor;
    });

    it("clears oracle floor config and emits", async () => {
      await expect(subject())
        .to.emit(controller, "DepositOracleFloorConfigCleared")
        .withArgs(subjectEscrow, subjectDepositId, subjectPaymentMethod, subjectCurrencyCode);

      const stored = await controller.getDepositOracleFloorConfig(
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode
      );
      expect(stored.isConfigured).to.eq(false);
      expect(stored.adapter).to.eq(ADDRESS_ZERO);
      expect(stored.spreadBps).to.eq(0);
      expect(stored.maxStaleness).to.eq(0);
      expect(stored.adapterConfig).to.eq("0x");
    });

    describe("when caller is delegate", () => {
      beforeEach(async () => {
        subjectCaller = manager;
      });

      it("clears oracle floor config", async () => {
        await subject();
        const stored = await controller.getDepositOracleFloorConfig(
          subjectEscrow,
          subjectDepositId,
          subjectPaymentMethod,
          subjectCurrencyCode
        );
        expect(stored.isConfigured).to.eq(false);
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

    describe("when caller is unauthorized", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidPaymentMethod");
      });
    });

    describe("when currency is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "InvalidCurrency");
      });
    });

    describe("when escrow is zero", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "ZeroAddress");
      });
    });

    describe("when config is missing", () => {
      beforeEach(async () => {
        await controller.connect(depositor.wallet).clearDepositOracleFloorConfig(
          subjectEscrow,
          subjectDepositId,
          subjectPaymentMethod,
          subjectCurrencyCode
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(controller, "OracleFloorConfigNotSet");
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

    describe("when oracle floor is configured and fresh", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 100_000_000)) as AggregatorV3Mock;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );
      });

      it("returns max(fixed floor, marketRate + spread)", async () => {
        expect(await subject()).to.eq(ether(1.01));
      });
    });

    describe("when oracle floor computes below fixed floor", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 98_000_000)) as AggregatorV3Mock;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );
      });

      it("returns fixed floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
    });

    describe("when oracle quote is stale", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 120_000_000)) as AggregatorV3Mock;

        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 120_000_000, now - 10_000, now - 10_000, 1);

        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );
      });

      it("falls back to fixed floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
    });

    describe("when oracle quote is unavailable", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          staticAdapter.address,
          ethers.utils.defaultAbiCoder.encode(["bool", "uint256", "uint256"], [false, ether(2), now]),
          100,
          3600
        );
      });

      it("falls back to fixed floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
    });

    describe("when oracle quote timestamp is in the future", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          staticAdapter.address,
          ethers.utils.defaultAbiCoder.encode(["bool", "uint256", "uint256"], [true, ether(2), now + 60]),
          100,
          3600
        );
      });

      it("falls back to fixed floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
    });

    describe("when oracle adapter reverts", () => {
      beforeEach(async () => {
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          revertingAdapter.address,
          "0x",
          100,
          3600
        );
      });

      it("falls back to fixed floor", async () => {
        expect(await subject()).to.eq(ether(1));
      });
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

    describe("when manager min > dynamic floor", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 100_000_000)) as AggregatorV3Mock;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );

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

    describe("when manager min < dynamic floor", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 100_000_000)) as AggregatorV3Mock;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );

        const rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await registry.connect(manager.wallet).setMinRate(
          rateManagerId,
          paymentMethod,
          Currency.USD,
          ethers.utils.parseEther("1.005")
        );
        await controller.connect(depositor.wallet).setDepositRateManager(escrow.address, 0, registry.address, rateManagerId);
      });

      it("returns dynamic floor", async () => {
        expect(await subject()).to.eq(ether(1.01));
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

    describe("when currency was never enabled on escrow", () => {
      beforeEach(async () => {
        subjectCurrency = Currency.EUR;
      });

      it("returns 0", async () => {
        expect(await subject()).to.eq(ZERO);
      });
    });

    describe("when manager enables unlisted currency", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 120_000_000)) as AggregatorV3Mock;
        await controller.connect(depositor.wallet).setDepositOracleFloorConfig(
          escrow.address,
          0,
          paymentMethod,
          Currency.EUR,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100,
          3600
        );

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

      it("returns 0 due to currency whitelist enforcement", async () => {
        expect(await subject()).to.eq(ZERO);
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
