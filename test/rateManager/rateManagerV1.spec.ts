import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerV1,
  RevertingOracleAdapterMock,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("RateManagerV1", () => {
  let owner: any;
  let manager: any;
  let depositor: any;
  let feeRecipient: any;
  let other: any;

  let deployer: DeployHelper;

  let rateManagerV1: RateManagerV1;
  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let staticOracleAdapter: StaticOracleAdapterMock;
  let revertingOracleAdapter: RevertingOracleAdapterMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerId: string;

  async function createRateManagerAndGetId(): Promise<string> {
    const tx = await rateManagerV1.createRateManager({
      manager: manager.address,
      feeRecipient: feeRecipient.address,
      maxFee: ether(0.05),
      fee: ether(0.01),
      name: "PeerOne",
      uri: "ipfs://peerone",
    });
    const receipt = await tx.wait();
    const createdEvent = receipt.events?.find((event: any) => event.event === "RateManagerCreated");
    return createdEvent?.args?.rateManagerId;
  }

  beforeEach(async () => {
    [owner, manager, depositor, feeRecipient, other] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    rateManagerV1 = await deployer.deployRateManagerV1();

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingOracleAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(60 * 60)
    );

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    rateManagerId = await createRateManagerAndGetId();
  });

  describe("#createRateManager", () => {
    let subjectManager: string;
    let subjectFeeRecipient: string;
    let subjectMaxFee: BigNumber;
    let subjectFee: BigNumber;

    async function subject() {
      return rateManagerV1.createRateManager({
        manager: subjectManager,
        feeRecipient: subjectFeeRecipient,
        maxFee: subjectMaxFee,
        fee: subjectFee,
        name: "RM",
        uri: "ipfs://rm",
      });
    }

    beforeEach(async () => {
      subjectManager = manager.address;
      subjectFeeRecipient = feeRecipient.address;
      subjectMaxFee = ether(0.05);
      subjectFee = ether(0.01);
    });

    it("creates manager and emits event", async () => {
      await expect(subject()).to.emit(rateManagerV1, "RateManagerCreated");
    });

    describe("when maxFee exceeds global cap", () => {
      beforeEach(async () => {
        subjectMaxFee = ether(0.06);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "FeeExceedsMaximum");
      });
    });
  });

  describe("#setRate", () => {
    let subjectCaller: any;
    let subjectRate: BigNumber;

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRate(rateManagerId, paymentMethod, Currency.USD, subjectRate);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRate = ether(1.1);
    });

    it("sets manager rate", async () => {
      await expect(subject())
        .to.emit(rateManagerV1, "RateManagerRateUpdated")
        .withArgs(rateManagerId, paymentMethod, Currency.USD, subjectRate);

      expect(await rateManagerV1.getManagerRate(rateManagerId, paymentMethod, Currency.USD)).to.eq(subjectRate);
    });

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
      });
    });
  });

  describe("#setFee", () => {
    let subjectCaller: any;
    let subjectFee: BigNumber;

    async function subject() {
      return rateManagerV1.connect(subjectCaller.wallet).setFee(rateManagerId, subjectFee);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectFee = ether(0.02);
    });

    it("updates fee", async () => {
      await expect(subject()).to.emit(rateManagerV1, "RateManagerFeeUpdated").withArgs(rateManagerId, subjectFee);

      const feeConfig = await rateManagerV1.getFee(rateManagerId);
      expect(feeConfig.recipient).to.eq(feeRecipient.address);
      expect(feeConfig.fee).to.eq(subjectFee);
    });

    describe("when fee exceeds manager maxFee", () => {
      beforeEach(async () => {
        subjectFee = ether(0.06);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "FeeExceedsMaximum");
      });
    });
  });

  describe("#setRateManagerConfig", () => {
    let subjectCaller: any;
    let subjectManager: string;
    let subjectFeeRecipient: string;
    let subjectName: string;
    let subjectUri: string;

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRateManagerConfig(rateManagerId, subjectManager, subjectFeeRecipient, subjectName, subjectUri);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectManager = other.address;
      subjectFeeRecipient = other.address;
      subjectName = "Updated RM";
      subjectUri = "ipfs://updated";
    });

    it("updates rate manager config fields", async () => {
      await expect(subject())
        .to.emit(rateManagerV1, "RateManagerConfigUpdated")
        .withArgs(rateManagerId, subjectManager, subjectFeeRecipient, subjectName, subjectUri);

      const updatedConfig = await rateManagerV1.getRateManager(rateManagerId);
      expect(updatedConfig.manager).to.eq(subjectManager);
      expect(updatedConfig.feeRecipient).to.eq(subjectFeeRecipient);
      expect(updatedConfig.name).to.eq(subjectName);
      expect(updatedConfig.uri).to.eq(subjectUri);
    });

    describe("when manager is zero address", () => {
      beforeEach(async () => {
        subjectManager = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });

    describe("when current fee is non-zero and fee recipient is zero address", () => {
      beforeEach(async () => {
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });

    describe("when current fee is zero and fee recipient is zero address", () => {
      beforeEach(async () => {
        await rateManagerV1.connect(manager.wallet).setFee(rateManagerId, ZERO);
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("updates config", async () => {
        await subject();
        const updatedConfig = await rateManagerV1.getRateManager(rateManagerId);
        expect(updatedConfig.feeRecipient).to.eq(ADDRESS_ZERO);
      });
    });
  });

  describe("#setRateBatch", () => {
    let subjectCaller: any;
    let subjectPaymentMethods: BytesLike[];
    let subjectCurrencyCodes: BytesLike[][];
    let subjectRates: BigNumber[][];

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRateBatch(rateManagerId, subjectPaymentMethods, subjectCurrencyCodes, subjectRates);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectPaymentMethods = [paymentMethod];
      subjectCurrencyCodes = [[Currency.USD]];
      subjectRates = [[ether(1.15)]];
    });

    it("sets manager rates in batch and emits aggregate event", async () => {
      await expect(subject())
        .to.emit(rateManagerV1, "RateManagerRatesBatchUpdated")
        .withArgs(rateManagerId, 1);

      const managerRate = await rateManagerV1.getManagerRate(rateManagerId, paymentMethod, Currency.USD);
      expect(managerRate).to.eq(ether(1.15));
    });

    describe("when payment methods length does not match currencies length", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when payment methods length does not match rates length", () => {
      beforeEach(async () => {
        subjectRates = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when currency codes length does not match rates length for an index", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[Currency.USD, ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethods = [ethers.constants.HashZero];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });
  });

  describe("#setDepositorFloorBatch", () => {
    let subjectCaller: any;
    let subjectPaymentMethods: BytesLike[];
    let subjectCurrencyCodes: BytesLike[][];
    let subjectConfigs: any[][];

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setDepositorFloorBatch(
          rateManagerId,
          escrow.address,
          ZERO,
          subjectPaymentMethods,
          subjectCurrencyCodes,
          subjectConfigs as any
        );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectPaymentMethods = [paymentMethod];
      subjectCurrencyCodes = [[Currency.USD]];
      subjectConfigs = [[{
        floorFixed: ether(1.05),
        floorSpreadBps: 0,
        oracleAdapter: ADDRESS_ZERO,
        adapterConfig: "0x",
        maxStaleness: 0,
      }]];
    });

    it("sets depositor floors in batch", async () => {
      await expect(subject()).to.emit(rateManagerV1, "DepositorFloorSet");
      const floorConfig = await rateManagerV1.getDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD
      );
      expect(floorConfig.floorFixed).to.eq(ether(1.05));
    });

    describe("when payment methods length does not match currencies length", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when payment methods length does not match configs length", () => {
      beforeEach(async () => {
        subjectConfigs = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when currency codes length does not match config length for an index", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[Currency.USD, ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });
  });

  describe("#setDepositorFloor", () => {
    let subjectCaller: any;
    let subjectConfig: any;

    async function subject() {
      return rateManagerV1.connect(subjectCaller.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        subjectConfig
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectConfig = {
        floorFixed: ether(1),
        floorSpreadBps: 0,
        oracleAdapter: ADDRESS_ZERO,
        adapterConfig: "0x",
        maxStaleness: 0,
      };
    });

    describe("when oracle adapter is zero but oracle fields are non-empty", () => {
      beforeEach(async () => {
        subjectConfig = {
          floorFixed: ether(1),
          floorSpreadBps: 1,
          oracleAdapter: ADDRESS_ZERO,
          adapterConfig: "0x1234",
          maxStaleness: 1,
        };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "InvalidOracleAdapter");
      });
    });

    describe("when normalized adapter config is too long", () => {
      beforeEach(async () => {
        subjectConfig = {
          floorFixed: ether(1),
          floorSpreadBps: 50,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig: `0x${"11".repeat(257)}`,
          maxStaleness: 3600,
        };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "AdapterConfigTooLong");
      });
    });
  });

  describe("#setDepositorCurrencyEnabledBatch", () => {
    let subjectCaller: any;
    let subjectPaymentMethods: BytesLike[];
    let subjectCurrencyCodes: BytesLike[][];
    let subjectEnabled: boolean[][];

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setDepositorCurrencyEnabledBatch(
          rateManagerId,
          escrow.address,
          ZERO,
          subjectPaymentMethods,
          subjectCurrencyCodes,
          subjectEnabled
        );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectPaymentMethods = [paymentMethod];
      subjectCurrencyCodes = [[Currency.USD]];
      subjectEnabled = [[true]];
    });

    it("sets enabled flags in batch", async () => {
      await expect(subject()).to.emit(rateManagerV1, "DepositorCurrencyEnabledSet");

      expect(
        await rateManagerV1.isDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD)
      ).to.eq(true);
    });

    describe("when payment methods length does not match currencies length", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when payment methods length does not match enabled length", () => {
      beforeEach(async () => {
        subjectEnabled = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });

    describe("when currency codes length does not match enabled length for an index", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[Currency.USD, ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ArrayLengthMismatch");
      });
    });
  });

  describe("#getRate", () => {
    beforeEach(async () => {
      await rateManagerV1.connect(manager.wallet).setRate(rateManagerId, paymentMethod, Currency.USD, ether(1.1));
    });

    it("returns zero when currency is disabled for depositor", async () => {
      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns manager rate when enabled and no floor set", async () => {
      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("returns zero when manager rate is not configured", async () => {
      await rateManagerV1
        .connect(manager.wallet)
        .setRate(rateManagerId, paymentMethod, Currency.USD, ZERO);
      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns max(floorFixed, managerRate)", async () => {
      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ether(1.2),
          floorSpreadBps: 0,
          oracleAdapter: ADDRESS_ZERO,
          adapterConfig: "0x",
          maxStaleness: 0,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.2));
    });

    it("uses oracle spread floor when configured", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp]
      );

      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ZERO,
          floorSpreadBps: 100,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const expectedFloor = ether(1.3).mul(10_100).add(9_999).div(10_000);
      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(expectedFloor);
    });

    it("falls back to manager rate when oracle quote is invalid", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [false, ether(1.3), currentTimestamp]
      );

      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("falls back to manager rate when oracle timestamp is in the future", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp + 100]
      );

      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("falls back to manager rate when oracle quote is stale", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp - 8_000]
      );

      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("falls back to manager rate when oracle adapter reverts", async () => {
      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: revertingOracleAdapter.address,
          adapterConfig: "0x1234",
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });
  });

  describe("view getters", () => {
    it("returns rate manager config via getRateManager", async () => {
      const config = await rateManagerV1.getRateManager(rateManagerId);
      expect(config.manager).to.eq(manager.address);
      expect(config.feeRecipient).to.eq(feeRecipient.address);
    });

    it("returns depositor floor via getDepositorFloor", async () => {
      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          floorFixed: ether(1.07),
          floorSpreadBps: 0,
          oracleAdapter: ADDRESS_ZERO,
          adapterConfig: "0x",
          maxStaleness: 0,
        }
      );

      const floor = await rateManagerV1.getDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD
      );

      expect(floor.floorFixed).to.eq(ether(1.07));
    });

    it("returns depositor currency enabled via isDepositorCurrencyEnabled", async () => {
      await rateManagerV1
        .connect(depositor.wallet)
        .setDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, true);

      expect(
        await rateManagerV1.isDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD)
      ).to.eq(true);
    });
  });

  describe("depositor authorization", () => {
    it("reverts when non-depositor sets depositor floor", async () => {
      await expect(
        rateManagerV1.connect(other.wallet).setDepositorFloor(
          rateManagerId,
          escrow.address,
          ZERO,
          paymentMethod,
          Currency.USD,
          {
            floorFixed: ether(1),
            floorSpreadBps: 0,
            oracleAdapter: ADDRESS_ZERO,
            adapterConfig: "0x",
            maxStaleness: 0,
          }
        )
      ).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
    });

    it("validates onDepositOptIn depositor ownership", async () => {
      await expect(
        rateManagerV1.onDepositOptIn(other.address, escrow.address, ZERO, rateManagerId)
      ).to.be.reverted;
    });
  });
});
