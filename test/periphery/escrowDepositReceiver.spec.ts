import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";

const expect = getWaffleExpect();

describe("EscrowDepositReceiver", () => {
  let owner: any;
  let depositor: any;
  let finalizer: any;
  let other: any;
  let delegate: any;
  let intentGuardian: any;
  let dustRecipient: any;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let otherToken: Contract;
  let escrow: Contract;
  let factory: Contract;
  let receiver: Contract;

  let paymentMethod: string;
  let payeeDetails: string;
  let expiry: number;
  let userSalt: string;
  let depositParams: any;
  let order: any;

  const amount = usdc(30);

  async function deployOrder(overrides: Record<string, any> = {}) {
    const deploymentOrder = { ...order, ...overrides };
    const predicted = await factory.predictReceiverAddress(deploymentOrder, userSalt);
    await factory.connect(other.wallet).deployReceiver(deploymentOrder, userSalt);
    receiver = await ethers.getContractAt("EscrowDepositReceiver", predicted);
    return { predicted, deploymentOrder };
  }

  async function setNextTimestamp(timestamp: number) {
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  }

  beforeEach(async () => {
    [owner, depositor, finalizer, other, delegate, intentGuardian, dustRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    otherToken = await deployer.deployUSDCMock(usdc(1_000_000), "OTHER", "OTHER");

    const paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    const orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    const verifier = await deployer.deployPaymentVerifierMock();

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("revolut"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("richard2015"));

    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      dustRecipient.address,
      ZERO,
      BigNumber.from(3),
      BigNumber.from(60 * 60)
    );

    factory = await (await ethers.getContractFactory("EscrowDepositReceiverFactory", owner.wallet)).deploy();

    const latestBlock = await ethers.provider.getBlock("latest");
    expiry = latestBlock.timestamp + 60 * 60;
    userSalt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zcash-order-1"));

    depositParams = {
      token: usdcToken.address,
      amount,
      intentAmountRange: { min: amount, max: amount },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{
        intentGatingService: ADDRESS_ZERO,
        payeeDetails,
        data: "0x",
      }],
      currencies: [[{
        code: Currency.USD,
        minConversionRate: ether(1.5),
        oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
      }]],
      delegate: delegate.address,
      intentGuardian: intentGuardian.address,
      retainOnEmpty: false,
    };

    const depositParamsHash = await factory.hashDepositParams(depositParams);
    order = {
      token: usdcToken.address,
      escrow: escrow.address,
      depositor: depositor.address,
      amount,
      depositParamsHash,
      expiry,
    };
  });

  describe("constructor bindings", () => {
    it("rejects zero addresses", async () => {
      const receiverFactory = await ethers.getContractFactory("EscrowDepositReceiver", owner.wallet);

      await expect(receiverFactory.deploy(
        ADDRESS_ZERO,
        escrow.address,
        depositor.address,
        amount,
        order.depositParamsHash,
        expiry
      )).to.be.revertedWithCustomError(receiverFactory, "ZeroAddress");
    });

    it("rejects token or escrow addresses without code", async () => {
      const receiverFactory = await ethers.getContractFactory("EscrowDepositReceiver", owner.wallet);

      await expect(receiverFactory.deploy(
        other.address,
        escrow.address,
        depositor.address,
        amount,
        order.depositParamsHash,
        expiry
      )).to.be.revertedWithCustomError(receiverFactory, "AddressHasNoCode");

      await expect(receiverFactory.deploy(
        usdcToken.address,
        other.address,
        depositor.address,
        amount,
        order.depositParamsHash,
        expiry
      )).to.be.revertedWithCustomError(receiverFactory, "AddressHasNoCode");
    });

    it("rejects a zero amount or zero params commitment", async () => {
      const receiverFactory = await ethers.getContractFactory("EscrowDepositReceiver", owner.wallet);

      await expect(receiverFactory.deploy(
        usdcToken.address,
        escrow.address,
        depositor.address,
        ZERO,
        order.depositParamsHash,
        expiry
      )).to.be.revertedWithCustomError(receiverFactory, "ZeroAmount");

      await expect(receiverFactory.deploy(
        usdcToken.address,
        escrow.address,
        depositor.address,
        amount,
        ethers.constants.HashZero,
        expiry
      )).to.be.revertedWithCustomError(receiverFactory, "ZeroDepositParamsHash");
    });
  });

  describe("deterministic deployment", () => {
    it("matches the predicted CREATE2 address and binds every order field", async () => {
      const { predicted } = await deployOrder();

      expect(receiver.address).to.eq(predicted);
      expect(await ethers.provider.getCode(predicted)).not.to.eq("0x");
      expect(await receiver.token()).to.eq(usdcToken.address);
      expect(await receiver.escrow()).to.eq(escrow.address);
      expect(await receiver.depositor()).to.eq(depositor.address);
      expect(await receiver.amount()).to.eq(amount);
      expect(await receiver.depositParamsHash()).to.eq(order.depositParamsHash);
      expect(await receiver.expiry()).to.eq(expiry);
    });

    it("rejects a duplicate CREATE2 deployment", async () => {
      await deployOrder();

      await expect(factory.deployReceiver(order, userSalt)).to.be.reverted;
    });

    it("uses all immutable fields and the user salt in address derivation", async () => {
      const predicted = await factory.predictReceiverAddress(order, userSalt);
      const otherSaltAddress = await factory.predictReceiverAddress(
        order,
        ethers.utils.keccak256(ethers.utils.toUtf8Bytes("zcash-order-2"))
      );
      const otherAmountAddress = await factory.predictReceiverAddress(
        { ...order, amount: amount.add(ONE) },
        userSalt
      );

      expect(otherSaltAddress).not.to.eq(predicted);
      expect(otherAmountAddress).not.to.eq(predicted);
    });

    it("can deploy the committed receiver after expiry so stranded funds remain recoverable", async () => {
      const predicted = await factory.predictReceiverAddress(order, userSalt);
      await usdcToken.transfer(predicted, amount);
      await setNextTimestamp(expiry);

      await factory.connect(other.wallet).deployReceiver(order, userSalt);
      receiver = await ethers.getContractAt("EscrowDepositReceiver", predicted);
      await receiver.connect(depositor.wallet).recover(usdcToken.address);

      expect(await usdcToken.balanceOf(predicted)).to.eq(ZERO);
      expect(await usdcToken.balanceOf(depositor.address)).to.eq(amount);
    });
  });

  describe("finalize", () => {
    beforeEach(async () => {
      await deployOrder();
    });

    it("permissionlessly deposits the exact funds into real EscrowV2 for the immutable depositor", async () => {
      await usdcToken.transfer(receiver.address, amount);

      await expect(receiver.connect(finalizer.wallet).finalize(depositParams))
        .to.emit(receiver, "ReceiverFinalized")
        .withArgs(finalizer.address, depositor.address, amount)
        .and.to.emit(escrow, "DepositReceived")
        .withArgs(
          ZERO,
          depositor.address,
          usdcToken.address,
          amount,
          depositParams.intentAmountRange,
          delegate.address,
          intentGuardian.address
        );

      const createdDeposit = await escrow.getDeposit(ZERO);
      expect(createdDeposit.depositor).to.eq(depositor.address);
      expect(createdDeposit.remainingDeposits).to.eq(amount);
      expect(await usdcToken.balanceOf(receiver.address)).to.eq(ZERO);
      expect(await usdcToken.balanceOf(escrow.address)).to.eq(amount);
      expect(await usdcToken.allowance(receiver.address, escrow.address)).to.eq(ZERO);
      expect(await receiver.finalized()).to.eq(true);
    });

    it("rejects a replay after successful finalization", async () => {
      await usdcToken.transfer(receiver.address, amount);
      await receiver.finalize(depositParams);

      await expect(receiver.finalize(depositParams)).to.be.revertedWithCustomError(receiver, "AlreadyFinalized");
    });

    it("rejects a wrong token before checking the commitment", async () => {
      await usdcToken.transfer(receiver.address, amount);

      await expect(receiver.finalize({ ...depositParams, token: otherToken.address }))
        .to.be.revertedWithCustomError(receiver, "TokenMismatch");
    });

    it("rejects a wrong amount before checking the commitment", async () => {
      await usdcToken.transfer(receiver.address, amount);

      await expect(receiver.finalize({ ...depositParams, amount: amount.sub(ONE) }))
        .to.be.revertedWithCustomError(receiver, "AmountMismatch");
    });

    it("rejects any change to the nested deposit configuration", async () => {
      await usdcToken.transfer(receiver.address, amount);
      const changedParams = {
        ...depositParams,
        paymentMethodData: [{ ...depositParams.paymentMethodData[0], payeeDetails: ethers.constants.HashZero }],
      };
      const actualHash = await factory.hashDepositParams(changedParams);

      await expect(receiver.finalize(changedParams))
        .to.be.revertedWithCustomError(receiver, "DepositParamsHashMismatch");
      expect(actualHash).not.to.eq(order.depositParamsHash);
    });

    it("rejects underfunding without consuming the order", async () => {
      await usdcToken.transfer(receiver.address, amount.sub(ONE));

      await expect(receiver.finalize(depositParams))
        .to.be.revertedWithCustomError(receiver, "InsufficientReceiverBalance");

      expect(await receiver.finalized()).to.eq(false);
      expect(await usdcToken.allowance(receiver.address, escrow.address)).to.eq(ZERO);
    });

    it("rolls back state and allowance on EscrowV2 failure, then succeeds on retry", async () => {
      await usdcToken.transfer(receiver.address, amount);
      await escrow.connect(owner.wallet).pauseEscrow();

      await expect(receiver.connect(finalizer.wallet).finalize(depositParams))
        .to.be.revertedWithCustomError(receiver, "EscrowDepositFailed");

      expect(await receiver.finalized()).to.eq(false);
      expect(await usdcToken.balanceOf(receiver.address)).to.eq(amount);
      expect(await usdcToken.allowance(receiver.address, escrow.address)).to.eq(ZERO);

      await escrow.connect(owner.wallet).unpauseEscrow();
      await receiver.connect(finalizer.wallet).finalize(depositParams);

      expect(await receiver.finalized()).to.eq(true);
      expect((await escrow.getDeposit(ZERO)).depositor).to.eq(depositor.address);
    });

    it("deposits only the committed amount when overfunded and leaves the remainder recoverable", async () => {
      const surplus = usdc(2);
      await usdcToken.transfer(receiver.address, amount.add(surplus));

      await receiver.connect(finalizer.wallet).finalize(depositParams);

      expect(await usdcToken.balanceOf(receiver.address)).to.eq(surplus);
      expect((await escrow.getDeposit(ZERO)).remainingDeposits).to.eq(amount);

      await setNextTimestamp(expiry);
      await receiver.connect(depositor.wallet).recover(usdcToken.address);
      expect(await usdcToken.balanceOf(receiver.address)).to.eq(ZERO);
      expect(await usdcToken.balanceOf(depositor.address)).to.eq(surplus);
    });

    it("rejects finalization exactly at the expiry boundary", async () => {
      await usdcToken.transfer(receiver.address, amount);
      await setNextTimestamp(expiry);

      await expect(receiver.finalize(depositParams))
        .to.be.revertedWithCustomError(receiver, "OrderExpired");
    });
  });

  describe("recovery", () => {
    beforeEach(async () => {
      await deployOrder();
      await usdcToken.transfer(receiver.address, amount);
    });

    it("rejects recovery by the depositor before expiry", async () => {
      await expect(receiver.connect(depositor.wallet).recover(usdcToken.address))
        .to.be.revertedWithCustomError(receiver, "OrderNotExpired");
    });

    it("rejects recovery by any non-depositor after expiry", async () => {
      await setNextTimestamp(expiry);

      await expect(receiver.connect(other.wallet).recover(usdcToken.address))
        .to.be.revertedWithCustomError(receiver, "UnauthorizedCaller");
    });

    it("lets only the depositor recover the committed token at expiry", async () => {
      await setNextTimestamp(expiry);

      await expect(receiver.connect(depositor.wallet).recover(usdcToken.address))
        .to.emit(receiver, "ReceiverFundsRecovered")
        .withArgs(usdcToken.address, depositor.address, amount);

      expect(await usdcToken.balanceOf(depositor.address)).to.eq(amount);
      expect(await usdcToken.balanceOf(receiver.address)).to.eq(ZERO);
      expect(await usdcToken.allowance(receiver.address, escrow.address)).to.eq(ZERO);
    });

    it("lets the depositor recover a wrong-token transfer after expiry", async () => {
      const wrongTokenAmount = usdc(4);
      await otherToken.transfer(receiver.address, wrongTokenAmount);
      await setNextTimestamp(expiry);

      await receiver.connect(depositor.wallet).recover(otherToken.address);

      expect(await otherToken.balanceOf(depositor.address)).to.eq(wrongTokenAmount);
      expect(await otherToken.balanceOf(receiver.address)).to.eq(ZERO);
    });
  });
});
