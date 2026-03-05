import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import {
  EscrowV2,
  OrchestratorRegistry,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerMock,
  ReentrantRateManagerMock,
  StaticOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("EscrowV2", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let other: any;
  let feeRecipient: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let verifier: PaymentVerifierMock;
  let rateManagerMock: RateManagerMock;
  let staticOracleAdapter: StaticOracleAdapterMock;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerId: BytesLike;

  beforeEach(async () => {
    [owner, depositor, delegate, other, feeRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();
    rateManagerMock = await deployer.deployRateManagerMock();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    rateManagerId = ethers.utils.formatBytes32String("manager-1");

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
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    await rateManagerMock.connect(owner.wallet).setManager(rateManagerId, true);
    await rateManagerMock.connect(owner.wallet).setFee(rateManagerId, feeRecipient.address, ether(0.01));
    await rateManagerMock
      .connect(owner.wallet)
      .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ether(1.2));
  });

  describe("#setRateManager", () => {
    let subjectCaller: any;
    let subjectRateManagerAddress: string;
    let subjectRateManagerId: BytesLike;

    async function subject() {
      return escrow
        .connect(subjectCaller.wallet)
        .setRateManager(ZERO, subjectRateManagerAddress, subjectRateManagerId);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectRateManagerAddress = rateManagerMock.address;
      subjectRateManagerId = rateManagerId;
    });

    it("sets delegated manager and emits event", async () => {
      await expect(subject())
        .to.emit(escrow, "DepositRateManagerSet")
        .withArgs(ZERO, rateManagerMock.address, rateManagerId);

      const config = await escrow.getDepositRateManager(ZERO);
      expect(config.rateManager).to.eq(rateManagerMock.address);
      expect(config.rateManagerId).to.eq(rateManagerId);
    });

    it("calls onDepositOptIn on manager", async () => {
      await expect(subject())
        .to.emit(rateManagerMock, "OptedIn")
        .withArgs(escrow.address, ZERO, rateManagerId);
    });

    describe("when manager already set", () => {
      beforeEach(async () => {
        await subject();
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "RateManagerAlreadySet");
      });
    });

    describe("when caller is delegate", () => {
      beforeEach(async () => {
        subjectCaller = delegate;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });

    describe("when manager rejects opt-in", () => {
      beforeEach(async () => {
        await rateManagerMock.connect(owner.wallet).setShouldRevertOnOptIn(true);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(rateManagerMock, "OptInRejected");
      });
    });

    describe("when malicious manager attempts reentrancy during onDepositOptIn", () => {
      let reentrantManager: ReentrantRateManagerMock;
      let attackManagerId: BytesLike;

      beforeEach(async () => {
        reentrantManager = await deployer.deployReentrantRateManagerMock(escrow.address);
        attackManagerId = ethers.utils.formatBytes32String("attack-manager");
        await reentrantManager.setAttackParams(attackManagerId);

        subjectRateManagerAddress = reentrantManager.address;
        subjectRateManagerId = rateManagerId;
      });

      it("reentry is blocked by RateManagerAlreadySet since state is written before external call", async () => {
        await subject();

        expect(await reentrantManager.reentryAttempted()).to.be.true;
        expect(await reentrantManager.reentrySucceeded()).to.be.false;

        const config = await escrow.getDepositRateManager(ZERO);
        expect(config.rateManager).to.eq(reentrantManager.address);
        expect(config.rateManagerId).to.eq(rateManagerId);
      });
    });
  });

  describe("#clearRateManager", () => {
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).clearRateManager(ZERO);
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
    });

    it("clears delegated manager and emits event", async () => {
      await expect(subject())
        .to.emit(escrow, "DepositRateManagerCleared")
        .withArgs(ZERO, rateManagerMock.address, rateManagerId);

      const config = await escrow.getDepositRateManager(ZERO);
      expect(config.rateManager).to.eq(ADDRESS_ZERO);
      expect(config.rateManagerId).to.eq(ethers.constants.HashZero);
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });
  });

  describe("#getEffectiveRate", () => {
    it("returns native rate when deposit is not delegated", async () => {
      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("passes through to delegated manager when configured", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.2));
    });

    it("returns native rate after clear", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
      await escrow.connect(depositor.wallet).clearRateManager(ZERO);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("falls back to escrow floor when delegated manager reverts", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
      await rateManagerMock.connect(owner.wallet).setShouldRevertOnGetRate(true);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("returns escrow floor when manager rate is below floor", async () => {
      await rateManagerMock
        .connect(owner.wallet)
        .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ether(0.9));
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });

    it("returns 0 when escrow floor is 0 (currency deactivated)", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
      await escrow.connect(depositor.wallet).deactivateCurrency(ZERO, paymentMethod, Currency.USD);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns 0 when delegated manager returns 0 (pair disabled)", async () => {
      await rateManagerMock
        .connect(owner.wallet)
        .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ZERO);
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns 0 when oracle configured but stale, even with delegation", async () => {
      const currentTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
      const adapterConfig = ethers.utils.defaultAbiCoder.encode(
        ["bool", "uint256", "uint256"],
        [true, ether(1.3), currentTimestamp - 100]
      );
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        ZERO,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig,
          spreadBps: 0,
          maxStaleness: 5,
        }
      );
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ZERO);
    });

    it("returns max(managerRate, escrowFloor) when both are nonzero", async () => {
      await rateManagerMock
        .connect(owner.wallet)
        .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ether(1.5));
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1.5));
    });

    it("returns escrow floor when manager rate equals floor", async () => {
      await rateManagerMock
        .connect(owner.wallet)
        .setRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD, ether(1));
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      expect(await escrow.getEffectiveRate(ZERO, paymentMethod, Currency.USD)).to.eq(ether(1));
    });
  });

  describe("#getManagerFee", () => {
    it("returns zero fee when not delegated", async () => {
      const feeConfig = await escrow.getManagerFee(ZERO);
      expect(feeConfig.recipient).to.eq(ADDRESS_ZERO);
      expect(feeConfig.fee).to.eq(ZERO);
    });

    it("returns delegated manager fee", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);

      const feeConfig = await escrow.getManagerFee(ZERO);
      expect(feeConfig.recipient).to.eq(feeRecipient.address);
      expect(feeConfig.fee).to.eq(ether(0.01));
    });

    it("returns zero fee when delegated manager reverts", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
      await rateManagerMock.connect(owner.wallet).setShouldRevertOnGetFee(true);

      const feeConfig = await escrow.getManagerFee(ZERO);
      expect(feeConfig.recipient).to.eq(ADDRESS_ZERO);
      expect(feeConfig.fee).to.eq(ZERO);
    });
  });
});
