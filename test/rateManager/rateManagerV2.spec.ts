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
  RateManagerV2,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("RateManagerV2", () => {
  let owner: any;
  let manager: any;
  let depositor: any;
  let feeRecipient: any;
  let other: any;

  let deployer: DeployHelper;

  let rateManagerV1: RateManagerV1;
  let rateManagerV2: RateManagerV2;
  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerId: string;

  async function createRateManagerAndGetId(minLiquidity = ZERO): Promise<string> {
    const tx = await rateManagerV2.createRateManager({
      manager: manager.address,
      feeRecipient: feeRecipient.address,
      maxFee: ether(0.05),
      fee: ether(0.01),
      minLiquidity,
      name: "PeerTwo",
      uri: "ipfs://peertwo",
    });
    const receipt = await tx.wait();
    const createdEvent = receipt.events?.find((event: any) => event.event === "RateManagerCreated");
    return createdEvent?.args?.rateManagerId;
  }

  async function createLegacyRateManagerAndGetId(minLiquidity = ZERO): Promise<string> {
    const tx = await rateManagerV1.createRateManager({
      manager: manager.address,
      feeRecipient: feeRecipient.address,
      maxFee: ether(0.05),
      fee: ether(0.01),
      minLiquidity,
      name: "LegacyPeer",
      uri: "ipfs://legacy-peer",
    });
    const receipt = await tx.wait();
    const createdEvent = receipt.events?.find((event: any) => event.event === "RateManagerCreated");
    return createdEvent?.args?.rateManagerId;
  }

  async function setStandardTranches(subjectRateManagerId: BytesLike) {
    await rateManagerV2.connect(manager.wallet).setTrancheRates(subjectRateManagerId, paymentMethod, Currency.USD, [
      {
        maxLiquidity: usdc(100),
        rate: ether(1.05),
      },
      {
        maxLiquidity: usdc(500),
        rate: ether(1.02),
      },
    ]);
  }

  beforeEach(async () => {
    [owner, manager, depositor, feeRecipient, other] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    escrowRegistry = await deployer.deployEscrowRegistry();
    rateManagerV1 = await deployer.deployRateManagerV1(escrowRegistry.address);
    rateManagerV2 = await deployer.deployRateManagerV2(escrowRegistry.address);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();

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
      return rateManagerV2.createRateManager({
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

    it("creates a manager and emits RateManagerCreated", async () => {
      await expect(subject()).to.emit(rateManagerV2, "RateManagerCreated");
    });

    it("emits MinLiquidityUpdated when minLiquidity is non-zero", async () => {
      const tx = await rateManagerV2.createRateManager({
        manager: subjectManager,
        feeRecipient: subjectFeeRecipient,
        maxFee: subjectMaxFee,
        fee: subjectFee,
        minLiquidity: usdc(50),
        name: "RM",
        uri: "ipfs://rm",
      });

      await expect(tx).to.emit(rateManagerV2, "RateManagerCreated");
      await expect(tx).to.emit(rateManagerV2, "MinLiquidityUpdated");
    });

    describe("when maxFee exceeds the global cap", () => {
      beforeEach(async () => {
        subjectMaxFee = ether(0.06);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "FeeExceedsMaximum");
      });
    });

    describe("when manager is zero address", () => {
      beforeEach(async () => {
        subjectManager = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
      });
    });

    describe("when fee recipient is zero and fee is non-zero", () => {
      beforeEach(async () => {
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
      });
    });

    describe("when fee exceeds maxFee", () => {
      beforeEach(async () => {
        subjectFee = ether(0.02);
        subjectMaxFee = ether(0.01);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "FeeExceedsMaximum");
      });
    });
  });

  describe("constructor", () => {
    it("reverts when escrow registry is zero address", async () => {
      const factory = await ethers.getContractFactory("RateManagerV2", owner.wallet);

      await expect(factory.deploy(ADDRESS_ZERO)).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
    });
  });

  describe("#importRateManager", () => {
    let legacyRateManagerId: string;

    beforeEach(async () => {
      legacyRateManagerId = await createLegacyRateManagerAndGetId(usdc(25));
      await rateManagerV1.connect(manager.wallet).setRate(legacyRateManagerId, paymentMethod, Currency.USD, ether(1.11));
    });

    it("copies the legacy config, keeps the legacy id, and copies requested flat rates", async () => {
      const tx = await rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [paymentMethod], [[Currency.USD]]);
      await expect(tx)
        .to.emit(rateManagerV2, "RateManagerImported")
        .withArgs(legacyRateManagerId, rateManagerV1.address, legacyRateManagerId, 1);

      const importedConfig = await rateManagerV2.getRateManager(legacyRateManagerId);
      expect(importedConfig.manager).to.eq(manager.address);
      expect(importedConfig.feeRecipient).to.eq(feeRecipient.address);
      expect(importedConfig.minLiquidity).to.eq(usdc(25));
      expect(await rateManagerV2.getManagerRate(legacyRateManagerId, paymentMethod, Currency.USD)).to.eq(ether(1.11));

      const legacySource = await rateManagerV2.getLegacySource(legacyRateManagerId);
      expect(legacySource.legacyRateManager).to.eq(rateManagerV1.address);
      expect(legacySource.legacyRateManagerId).to.eq(legacyRateManagerId);
    });

    it("supports importing only the manager metadata", async () => {
      await rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [], []);

      expect(await rateManagerV2.getManagerRate(legacyRateManagerId, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    describe("when the legacy manager address is zero", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(ADDRESS_ZERO, legacyRateManagerId, [paymentMethod], [[Currency.USD]])
        ).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
      });
    });

    describe("when the legacy manager address has no code", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(other.address, legacyRateManagerId, [paymentMethod], [[Currency.USD]])
        ).to.be.revertedWithCustomError(rateManagerV2, "InvalidLegacyRateManager");
      });
    });

    describe("when the payment method and currency array lengths do not match", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [paymentMethod], [])
        ).to.be.revertedWithCustomError(rateManagerV2, "ArrayLengthMismatch");
      });
    });

    describe("when the legacy manager id does not exist", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(
            rateManagerV1.address,
            ethers.utils.formatBytes32String("missing"),
            [paymentMethod],
            [[Currency.USD]]
          )
        ).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });

    describe("when the imported id already exists in V2", () => {
      beforeEach(async () => {
        await rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [], []);
      });

      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [], [])
        ).to.be.revertedWithCustomError(rateManagerV2, "RateManagerAlreadyExists");
      });
    });

    describe("when a copied payment method is zero", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [ethers.constants.HashZero], [[Currency.USD]])
        ).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when a copied currency is zero", () => {
      it("reverts", async () => {
        await expect(
          rateManagerV2.importRateManager(rateManagerV1.address, legacyRateManagerId, [paymentMethod], [[ethers.constants.HashZero]])
        ).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
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
      return rateManagerV2
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

    it("sets the flat manager rate", async () => {
      await expect(subject())
        .to.emit(rateManagerV2, "RateManagerRateUpdated")
        .withArgs(rateManagerId, paymentMethod, Currency.USD, subjectRate);

      expect(await rateManagerV2.getManagerRate(rateManagerId, paymentMethod, Currency.USD)).to.eq(subjectRate);
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when the manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
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
      return rateManagerV2
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

    it("sets flat manager rates in batch", async () => {
      await expect(subject())
        .to.emit(rateManagerV2, "RateManagerRatesBatchUpdated")
        .withArgs(rateManagerId, 1);

      expect(await rateManagerV2.getManagerRate(rateManagerId, paymentMethod, Currency.USD)).to.eq(ether(1.15));
    });

    describe("when payment methods length does not match currencies length", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ArrayLengthMismatch");
      });
    });

    describe("when payment methods length does not match rates length", () => {
      beforeEach(async () => {
        subjectRates = [];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ArrayLengthMismatch");
      });
    });

    describe("when currency codes length does not match rates length for an index", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[Currency.USD, ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ArrayLengthMismatch");
      });
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethods = [ethers.constants.HashZero];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCodes = [[ethers.constants.HashZero]];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });
  });

  describe("#setTrancheRates", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;
    let subjectTranches: { maxLiquidity: BigNumber; rate: BigNumber }[];

    async function subject() {
      return rateManagerV2
        .connect(subjectCaller.wallet)
        .setTrancheRates(subjectRateManagerId, subjectPaymentMethod, subjectCurrencyCode, subjectTranches);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      subjectTranches = [
        { maxLiquidity: usdc(100), rate: ether(1.05) },
        { maxLiquidity: usdc(500), rate: ether(1.02) },
      ];
    });

    it("stores an ordered tranche schedule", async () => {
      await expect(subject())
        .to.emit(rateManagerV2, "RateManagerTrancheRatesUpdated")
        .withArgs(rateManagerId, paymentMethod, Currency.USD, 2);

      const tranches = await rateManagerV2.getTrancheRates(rateManagerId, paymentMethod, Currency.USD);
      expect(tranches.length).to.eq(2);
      expect(tranches[0].maxLiquidity).to.eq(usdc(100));
      expect(tranches[0].rate).to.eq(ether(1.05));
      expect(tranches[1].maxLiquidity).to.eq(usdc(500));
      expect(tranches[1].rate).to.eq(ether(1.02));
      expect(await rateManagerV2.getRateForLiquidity(rateManagerId, paymentMethod, Currency.USD, usdc(80))).to.eq(ether(1.05));
      expect(await rateManagerV2.getRateForLiquidity(rateManagerId, paymentMethod, Currency.USD, usdc(300))).to.eq(ether(1.02));
    });

    it("replaces the previous tranche schedule", async () => {
      await subject();
      subjectTranches = [{ maxLiquidity: usdc(250), rate: ether(1.08) }];

      await subject();

      const tranches = await rateManagerV2.getTrancheRates(rateManagerId, paymentMethod, Currency.USD);
      expect(tranches.length).to.eq(1);
      expect(tranches[0].maxLiquidity).to.eq(usdc(250));
      expect(tranches[0].rate).to.eq(ether(1.08));
    });

    it("clears tranches when called with an empty schedule", async () => {
      await subject();
      subjectTranches = [];

      await expect(subject())
        .to.emit(rateManagerV2, "RateManagerTrancheRatesCleared")
        .withArgs(rateManagerId, paymentMethod, Currency.USD);

      const tranches = await rateManagerV2.getTrancheRates(rateManagerId, paymentMethod, Currency.USD);
      expect(tranches.length).to.eq(0);
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when a tranche max liquidity is zero", () => {
      beforeEach(async () => {
        subjectTranches = [{ maxLiquidity: ZERO, rate: ether(1.05) }];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when tranche upper bounds are not strictly increasing", () => {
      beforeEach(async () => {
        subjectTranches = [
          { maxLiquidity: usdc(100), rate: ether(1.05) },
          { maxLiquidity: usdc(100), rate: ether(1.02) },
        ];
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "InvalidTrancheOrder");
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });
  });

  describe("#clearTrancheRates", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrencyCode: BytesLike;

    async function subject() {
      return rateManagerV2
        .connect(subjectCaller.wallet)
        .clearTrancheRates(subjectRateManagerId, subjectPaymentMethod, subjectCurrencyCode);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectPaymentMethod = paymentMethod;
      subjectCurrencyCode = Currency.USD;
      await rateManagerV2.connect(manager.wallet).setRate(rateManagerId, paymentMethod, Currency.USD, ether(1.09));
      await setStandardTranches(rateManagerId);
    });

    it("clears tranches and falls back to the flat rate", async () => {
      await expect(subject())
        .to.emit(rateManagerV2, "RateManagerTrancheRatesCleared")
        .withArgs(rateManagerId, paymentMethod, Currency.USD);

      expect(await rateManagerV2.getTrancheRates(rateManagerId, paymentMethod, Currency.USD)).to.deep.eq([]);
      expect(await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.09));
    });

    describe("when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when currency code is zero", () => {
      beforeEach(async () => {
        subjectCurrencyCode = ethers.constants.HashZero;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroValue");
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });
  });

  describe("#getRate", () => {
    it("returns the flat manager rate when no tranches are set", async () => {
      await rateManagerV2.connect(manager.wallet).setRate(rateManagerId, paymentMethod, Currency.USD, ether(1.1));

      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("returns 0 when the flat rate has not been set", async () => {
      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns the active tranche rate for the deposit's current liquidity", async () => {
      await setStandardTranches(rateManagerId);

      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.02));
    });

    it("uses tranches ahead of the flat override when both are configured", async () => {
      await rateManagerV2.connect(manager.wallet).setRate(rateManagerId, paymentMethod, Currency.USD, ether(1.3));
      await setStandardTranches(rateManagerId);

      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.02));
    });

    it("moves into a tighter tranche after deposit liquidity shrinks", async () => {
      await setStandardTranches(rateManagerId);
      await escrow.connect(depositor.wallet).removeFunds(ZERO, usdc(420));

      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.05));
    });

    it("returns 0 when liquidity is above the highest configured tranche", async () => {
      await setStandardTranches(rateManagerId);
      await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(200));
      await escrow.connect(depositor.wallet).addFunds(ZERO, usdc(200));

      const rate = await rateManagerV2.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns 0 for a missing manager", async () => {
      const rate = await rateManagerV2.getRate(
        ethers.utils.formatBytes32String("missing-manager"),
        escrow.address,
        ZERO,
        paymentMethod,
        Currency.USD
      );
      expect(rate).to.eq(ZERO);
    });

    it("returns 0 when tranches are configured and escrow is zero address", async () => {
      await setStandardTranches(rateManagerId);

      const rate = await rateManagerV2.getRate(rateManagerId, ADDRESS_ZERO, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns 0 when tranche resolution points at an address with no code", async () => {
      await setStandardTranches(rateManagerId);

      const rate = await rateManagerV2.getRate(rateManagerId, other.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });

    it("returns 0 when tranche resolution calls a contract that does not implement getDeposit", async () => {
      await setStandardTranches(rateManagerId);

      const rate = await rateManagerV2.getRate(rateManagerId, rateManagerV1.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });
  });

  describe("view getters", () => {
    it("returns manager config via getRateManager", async () => {
      const config = await rateManagerV2.getRateManager(rateManagerId);
      expect(config.manager).to.eq(manager.address);
      expect(config.feeRecipient).to.eq(feeRecipient.address);
    });

    it("returns fee config via getFee", async () => {
      const feeConfig = await rateManagerV2.getFee(rateManagerId);
      expect(feeConfig.recipient).to.eq(feeRecipient.address);
      expect(feeConfig.fee).to.eq(ether(0.01));
    });

    it("returns zeroed legacy source for managers created natively in V2", async () => {
      const source = await rateManagerV2.getLegacySource(rateManagerId);
      expect(source.legacyRateManager).to.eq(ADDRESS_ZERO);
      expect(source.legacyRateManagerId).to.eq(ethers.constants.HashZero);
    });
  });

  describe("#setFee", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectFee: BigNumber;

    async function subject() {
      return rateManagerV2.connect(subjectCaller.wallet).setFee(subjectRateManagerId, subjectFee);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectFee = ether(0.02);
    });

    it("updates the manager fee", async () => {
      await expect(subject()).to.emit(rateManagerV2, "RateManagerFeeUpdated").withArgs(rateManagerId, subjectFee);

      const feeConfig = await rateManagerV2.getFee(rateManagerId);
      expect(feeConfig.recipient).to.eq(feeRecipient.address);
      expect(feeConfig.fee).to.eq(subjectFee);
    });

    describe("when fee exceeds maxFee", () => {
      beforeEach(async () => {
        subjectFee = ether(0.06);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "FeeExceedsMaximum");
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });

    describe("when fee recipient is zero and fee is set above zero", () => {
      beforeEach(async () => {
        await rateManagerV2.connect(manager.wallet).setFee(rateManagerId, ZERO);
        await rateManagerV2
          .connect(manager.wallet)
          .setRateManagerConfig(rateManagerId, manager.address, ADDRESS_ZERO, "RM", "ipfs://rm");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
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
      return rateManagerV2
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
        .to.emit(rateManagerV2, "RateManagerConfigUpdated")
        .withArgs(rateManagerId, subjectManager, subjectFeeRecipient, subjectName, subjectUri);

      const updatedConfig = await rateManagerV2.getRateManager(rateManagerId);
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
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
      });
    });

    describe("when current fee is non-zero and fee recipient is zero address", () => {
      beforeEach(async () => {
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
      });
    });

    describe("when current fee is zero and fee recipient is zero address", () => {
      beforeEach(async () => {
        await rateManagerV2.connect(manager.wallet).setFee(rateManagerId, ZERO);
        subjectFeeRecipient = ADDRESS_ZERO;
      });

      it("updates the config", async () => {
        await subject();
        const updatedConfig = await rateManagerV2.getRateManager(rateManagerId);
        expect(updatedConfig.feeRecipient).to.eq(ADDRESS_ZERO);
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });
  });

  describe("#setMinLiquidity", () => {
    let subjectCaller: any;
    let subjectRateManagerId: BytesLike;
    let subjectMinLiquidity: BigNumber;

    async function subject() {
      return rateManagerV2.connect(subjectCaller.wallet).setMinLiquidity(subjectRateManagerId, subjectMinLiquidity);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectRateManagerId = rateManagerId;
      subjectMinLiquidity = usdc(100);
    });

    it("sets min liquidity and emits MinLiquidityUpdated", async () => {
      await expect(subject())
        .to.emit(rateManagerV2, "MinLiquidityUpdated")
        .withArgs(rateManagerId, subjectMinLiquidity);

      expect((await rateManagerV2.getRateManager(rateManagerId)).minLiquidity).to.eq(subjectMinLiquidity);
    });

    describe("when clearing back to zero", () => {
      beforeEach(async () => {
        await rateManagerV2.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(100));
        subjectMinLiquidity = ZERO;
      });

      it("clears the min liquidity", async () => {
        await subject();
        expect((await rateManagerV2.getRateManager(rateManagerId)).minLiquidity).to.eq(ZERO);
      });
    });

    describe("when caller is not the manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedCaller");
      });
    });

    describe("when rate manager id does not exist", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.formatBytes32String("missing-manager");
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerV2, "RateManagerNotFound");
      });
    });
  });

  describe("#onDepositOptIn", () => {
    let escrowSigner: any;

    beforeEach(async () => {
      await ethers.provider.send("hardhat_impersonateAccount", [escrow.address]);
      escrowSigner = await ethers.getSigner(escrow.address);
      await ethers.provider.send("hardhat_setBalance", [escrow.address, "0xDE0B6B3A7640000"]);
    });

    afterEach(async () => {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [escrow.address]);
    });

    it("passes when no min liquidity is set", async () => {
      await expect(rateManagerV2.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)).to.not.be.reverted;
    });

    it("passes when the deposit liquidity meets the threshold", async () => {
      await rateManagerV2.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(100));

      await expect(rateManagerV2.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)).to.not.be.reverted;
    });

    it("reverts when the deposit liquidity is below the threshold", async () => {
      await rateManagerV2.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(1000));

      await expect(
        rateManagerV2.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)
      ).to.be.revertedWithCustomError(rateManagerV2, "BelowMinLiquidity");
    });

    it("passes when min liquidity is set and then cleared", async () => {
      await rateManagerV2.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(1000));
      await rateManagerV2.connect(manager.wallet).setMinLiquidity(rateManagerId, ZERO);

      await expect(rateManagerV2.connect(escrowSigner).onDepositOptIn(ZERO, rateManagerId)).to.not.be.reverted;
    });

    it("reverts when caller is not a whitelisted escrow", async () => {
      await expect(
        rateManagerV2.connect(other.wallet).onDepositOptIn(ZERO, rateManagerId)
      ).to.be.revertedWithCustomError(rateManagerV2, "UnauthorizedEscrow");
    });

    it("passes when caller is a whitelisted escrow", async () => {
      await escrowRegistry.addEscrow(owner.address);

      await expect(rateManagerV2.onDepositOptIn(ZERO, rateManagerId)).to.not.be.reverted;
    });

    it("passes when acceptAllEscrows is enabled", async () => {
      await escrowRegistry.setAcceptAllEscrows(true);

      await expect(rateManagerV2.connect(other.wallet).onDepositOptIn(ZERO, rateManagerId)).to.not.be.reverted;
    });

    it("reverts when the manager id does not exist", async () => {
      await escrowRegistry.setAcceptAllEscrows(true);

      await expect(
        rateManagerV2.connect(other.wallet).onDepositOptIn(ZERO, ethers.utils.formatBytes32String("missing-manager"))
      ).to.be.reverted;
    });
  });

  describe("#setEscrowRegistry", () => {
    it("updates the escrow registry", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await rateManagerV2.setEscrowRegistry(newRegistry.address);
      expect(await rateManagerV2.escrowRegistry()).to.eq(newRegistry.address);
    });

    it("emits EscrowRegistryUpdated", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await expect(rateManagerV2.setEscrowRegistry(newRegistry.address))
        .to.emit(rateManagerV2, "EscrowRegistryUpdated")
        .withArgs(newRegistry.address);
    });

    it("reverts when called by a non-owner", async () => {
      const newRegistry = await deployer.deployEscrowRegistry();
      await expect(
        rateManagerV2.connect(other.wallet).setEscrowRegistry(newRegistry.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("reverts when the new registry is zero address", async () => {
      await expect(rateManagerV2.setEscrowRegistry(ADDRESS_ZERO)).to.be.revertedWithCustomError(rateManagerV2, "ZeroAddress");
    });
  });
});
