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

    it("falls back to native rate when delegated manager reverts", async () => {
      await escrow.connect(depositor.wallet).setRateManager(ZERO, rateManagerMock.address, rateManagerId);
      await rateManagerMock.connect(owner.wallet).setShouldRevertOnGetRate(true);

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
