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
