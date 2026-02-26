import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowRegistry,
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
  let escrowRegistry: EscrowRegistry;
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
      minLiquidity: ZERO,
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

    escrowRegistry = await deployer.deployEscrowRegistry();
    rateManagerV1 = await deployer.deployRateManagerV1(escrowRegistry.address);

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

    await escrowRegistry.addEscrow(escrow.address);

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
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
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
        minLiquidity: ZERO,
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

    describe("when manager is zero address", () => {
      beforeEach(async () => {
        subjectManager = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });

    describe("when fee recipient is zero and fee is non-zero", () => {
      beforeEach(async () => {
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });

    describe("when fee exceeds maxFee", () => {
      beforeEach(async () => {
        subjectFee = ether(0.02);
        subjectMaxFee = ether(0.01);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "FeeExceedsMaximum");
      });
    });
  });

  describe("#setRate", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectRate: BigNumber;

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRate(subjectRateManagerId, subjectPaymentMethod, subjectCurrencyCode, subjectRate);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
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

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });
  });

  describe("#setFee", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectFee: BigNumber;

    async function subject() {
      return rateManagerV1.connect(subjectCaller.wallet).setFee(subjectRateManagerId, subjectFee);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
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

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });

    describe("when fee recipient is zero and fee is set above zero", () => {
      beforeEach(async () => {
        await rateManagerV1.connect(manager.wallet).setFee(rateManagerId, ZERO);
        await rateManagerV1
          .connect(manager.wallet)
          .setRateManagerConfig(rateManagerId, manager.address, ADDRESS_ZERO, "RM", "ipfs://rm");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });
  });

  describe("#setRateManagerConfig", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectManager: string;
    let subjectFeeRecipient: string;
    let subjectName: string;
    let subjectUri: string;

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRateManagerConfig(subjectRateManagerId, subjectManager, subjectFeeRecipient, subjectName, subjectUri);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
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

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });
  });

  describe("#setRateBatch", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectPaymentMethods: BytesLike[];
    let subjectCurrencyCodes: BytesLike[][];
    let subjectRates: BigNumber[][];

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setRateBatch(subjectRateManagerId, subjectPaymentMethods, subjectCurrencyCodes, subjectRates);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
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

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
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
        enabled: true,
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
      expect(floorConfig.enabled).to.eq(true);
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
    let subjectRateManagerId: BytesLike;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectConfig: any;

    async function subject() {
      return rateManagerV1.connect(subjectCaller.wallet).setDepositorFloor(
        subjectRateManagerId,
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode,
        subjectConfig
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectRateManagerId = rateManagerId;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      subjectConfig = {
        enabled: true,
        floorFixed: ether(1),
        floorSpreadBps: 0,
        oracleAdapter: ADDRESS_ZERO,
        adapterConfig: "0x",
        maxStaleness: 0,
      };
    });

    it("sets depositor floor", async () => {
      await expect(subject()).to.emit(rateManagerV1, "DepositorFloorSet");

      const floorConfig = await rateManagerV1.getDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD
      );
      expect(floorConfig.enabled).to.eq(true);
      expect(floorConfig.floorFixed).to.eq(ether(1));
    });

    describe("when oracle adapter is zero but oracle fields are non-empty", () => {
      beforeEach(async () => {
        subjectConfig = {
          enabled: true,
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

    describe("when oracle adapter is zero and only adapterConfig is set", () => {
      beforeEach(async () => {
        subjectConfig = {
          enabled: true,
          floorFixed: ether(1),
          floorSpreadBps: 0,
          oracleAdapter: ADDRESS_ZERO,
          adapterConfig: "0x1234",
          maxStaleness: 0,
        };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "InvalidOracleAdapter");
      });
    });

    describe("when oracle adapter is zero and only maxStaleness is set", () => {
      beforeEach(async () => {
        subjectConfig = {
          enabled: true,
          floorFixed: ether(1),
          floorSpreadBps: 0,
          oracleAdapter: ADDRESS_ZERO,
          adapterConfig: "0x",
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
          enabled: true,
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

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when floor spread exceeds max bps", () => {
      beforeEach(async () => {
        subjectConfig.floorSpreadBps = 10_001;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "InvalidSpread");
      });
    });

    describe("when oracle adapter is an EOA", () => {
      beforeEach(async () => {
        subjectConfig = {
          enabled: true,
          floorFixed: ether(1),
          floorSpreadBps: 100,
          oracleAdapter: other.address,
          adapterConfig: "0x1234",
          maxStaleness: 3600,
        };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "InvalidOracleAdapter");
      });
    });

    describe("when max staleness is zero for oracle floor", () => {
      beforeEach(async () => {
        subjectConfig = {
          enabled: true,
          floorFixed: ether(1),
          floorSpreadBps: 100,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig: "0x1234",
          maxStaleness: 0,
        };
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when escrow is zero", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
      });
    });

    describe("when deposit does not exist", () => {
      beforeEach(async () => {
        subjectDepositId = BigNumber.from(999);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "DepositNotFound");
      });
    });
  });

  describe("#setDepositorCurrencyEnabled", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectEnabled: boolean;

    async function subject() {
      return rateManagerV1.connect(subjectCaller.wallet).setDepositorCurrencyEnabled(
        subjectRateManagerId,
        subjectEscrow,
        subjectDepositId,
        subjectPaymentMethod,
        subjectCurrencyCode,
        subjectEnabled
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectRateManagerId = rateManagerId;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      subjectEnabled = true;
    });

    it("sets depositor currency enabled state", async () => {
      await expect(subject()).to.emit(rateManagerV1, "DepositorCurrencyEnabledSet");

      expect(
        await rateManagerV1.isDepositorCurrencyEnabled(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD)
      ).to.eq(true);
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "ZeroValue");
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
      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
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

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
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

    it("disables pair when oracle quote is invalid and no fixed floor", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [false, ether(1.3), currentTimestamp]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle quote is invalid", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [false, ether(1.3), currentTimestamp]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("disables pair when oracle timestamp is in the future and no fixed floor", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp + 100]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle timestamp is in the future", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp + 100]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("disables pair when oracle quote is stale and no fixed floor", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp - 8_000]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle quote is stale", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp - 8_000]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("disables pair when oracle adapter reverts and no fixed floor", async () => {
      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: revertingOracleAdapter.address,
          adapterConfig: "0x1234",
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle adapter reverts", async () => {
      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: revertingOracleAdapter.address,
          adapterConfig: "0x1234",
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("disables pair when oracle market rate is zero and no fixed floor", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ZERO, currentTimestamp]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle market rate is zero", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ZERO, currentTimestamp]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("disables pair when oracle timestamp is zero and no fixed floor", async () => {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), ZERO]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ZERO,
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
          maxStaleness: 3600,
        }
      );

      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("falls back to fixed floor when oracle timestamp is zero", async () => {
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), ZERO]
      );

      await rateManagerV1.connect(depositor.wallet).setDepositorFloor(
        rateManagerId,
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          enabled: true,
          floorFixed: ether(0.9),
          floorSpreadBps: 200,
          oracleAdapter: staticOracleAdapter.address,
          adapterConfig,
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
          enabled: true,
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

      expect(floor.enabled).to.eq(true);
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

  describe("#setMinLiquidity", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectMinLiquidity: BigNumber;

    async function subject() {
      return rateManagerV1
        .connect(subjectCaller.wallet)
        .setMinLiquidity(subjectRateManagerId, subjectMinLiquidity);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectMinLiquidity = usdc(100);
    });

    it("sets min liquidity and emits MinLiquidityUpdated event", async () => {
      await expect(subject())
        .to.emit(rateManagerV1, "MinLiquidityUpdated")
        .withArgs(rateManagerId, subjectMinLiquidity);

      expect((await rateManagerV1.getRateManager(rateManagerId)).minLiquidity).to.eq(subjectMinLiquidity);
    });

    it("reads back via getRateManager", async () => {
      await subject();
      expect((await rateManagerV1.getRateManager(rateManagerId)).minLiquidity).to.eq(usdc(100));
    });

    describe("when setting to 0 clears the requirement", () => {
      beforeEach(async () => {
        await rateManagerV1.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(100));
        subjectMinLiquidity = ZERO;
      });

      it("clears min liquidity", async () => {
        await subject();
        expect((await rateManagerV1.getRateManager(rateManagerId)).minLiquidity).to.eq(ZERO);
      });
    });

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV1, "RateManagerNotFound");
      });
    });
  });

  describe("#onDepositOptIn with minLiquidity", () => {
    let escrowSigner: any;

    beforeEach(async () => {
      // Impersonate the escrow contract so msg.sender == escrow in the callback
      await ethers.provider.send("hardhat_impersonateAccount", [escrow.address]);
      escrowSigner = await ethers.getSigner(escrow.address);
      await ethers.provider.send("hardhat_setBalance", [escrow.address, "0xDE0B6B3A7640000"]);
    });

    afterEach(async () => {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [escrow.address]);
    });

    it("passes when no min liquidity set (0 = disabled)", async () => {
      await expect(
        rateManagerV1.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)
      ).to.not.be.reverted;
    });

    it("passes when deposit liquidity meets threshold", async () => {
      // Deposit has 500 USDC, set min to 100 USDC
      await rateManagerV1.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(100));

      await expect(
        rateManagerV1.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)
      ).to.not.be.reverted;
    });

    it("reverts with BelowMinLiquidity when deposit liquidity is below threshold", async () => {
      // Deposit has 500 USDC, set min to 1000 USDC
      await rateManagerV1.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(1000));

      await expect(
        rateManagerV1.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)
      ).to.be.revertedWithCustomError(rateManagerV1, "BelowMinLiquidity");
    });

    it("passes when min liquidity is set then cleared back to 0", async () => {
      await rateManagerV1.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(1000));
      await rateManagerV1.connect(manager.wallet).setMinLiquidity(rateManagerId, ZERO);

      await expect(
        rateManagerV1.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)
      ).to.not.be.reverted;
    });
  });

  describe("#onDepositOptIn access control", () => {
    it("reverts when caller is not a whitelisted escrow", async () => {
      await expect(
        rateManagerV1.connect(other.wallet).onDepositOptIn(ZERO, rateManagerId)
      ).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedEscrow");
    });

    it("passes when caller is a whitelisted escrow", async () => {
      await escrowRegistry.addEscrow(owner.address);

      await expect(
        rateManagerV1.onDepositOptIn(ZERO, rateManagerId)
      ).to.not.be.reverted;
    });

    it("passes when acceptAllEscrows is enabled", async () => {
      await escrowRegistry.setAcceptAllEscrows(true);

      await expect(
        rateManagerV1.connect(other.wallet).onDepositOptIn(ZERO, rateManagerId)
      ).to.not.be.reverted;
    });
  });

  describe("#setEscrowRegistry", () => {
    it("updates escrow registry", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await rateManagerV1.setEscrowRegistry(newRegistry.address);
      expect(await rateManagerV1.escrowRegistry()).to.eq(newRegistry.address);
    });

    it("emits EscrowRegistryUpdated", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await expect(rateManagerV1.setEscrowRegistry(newRegistry.address))
        .to.emit(rateManagerV1, "EscrowRegistryUpdated")
        .withArgs(newRegistry.address);
    });

    it("reverts when called by non-owner", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await expect(
        rateManagerV1.connect(other.wallet).setEscrowRegistry(newRegistry.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when zero address", async () => {
      await expect(
        rateManagerV1.setEscrowRegistry(ADDRESS_ZERO)
      ).to.be.revertedWithCustomError(rateManagerV1, "ZeroAddress");
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
            enabled: true,
            floorFixed: ether(1),
            floorSpreadBps: 0,
            oracleAdapter: ADDRESS_ZERO,
            adapterConfig: "0x",
            maxStaleness: 0,
          }
        )
      ).to.be.revertedWithCustomError(rateManagerV1, "UnauthorizedCaller");
    });
  });
});
