import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc } from "@utils/common";
import { ADDRESS_ZERO, ZERO_BYTES32 } from "@utils/constants";

const expect = getWaffleExpect();

describe("AcrossSwapBridgeHook", () => {
  let owner: Account;
  let orchestrator: Account;
  let recipient: Account;
  let attacker: Account;
  let exchange: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let spokePool: Contract;
  let spokePoolPeriphery: Contract;
  let hook: Contract;

  const toBytes32 = (addr: string): string => ethers.utils.hexZeroPad(addr, 32);

  beforeEach(async () => {
    [owner, orchestrator, recipient, attacker, exchange] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const AcrossSpokePoolMock = await ethers.getContractFactory("AcrossSpokePoolMock", owner.wallet);
    spokePool = await AcrossSpokePoolMock.deploy();

    const AcrossSpokePoolPeripheryMock = await ethers.getContractFactory(
      "AcrossSpokePoolPeripheryMock",
      owner.wallet
    );
    spokePoolPeriphery = await AcrossSpokePoolPeripheryMock.deploy();

    const AcrossSwapBridgeHook = await ethers.getContractFactory("AcrossSwapBridgeHook", owner.wallet);
    hook = await AcrossSwapBridgeHook.deploy(
      usdcToken.address,
      orchestrator.address,
      spokePool.address,
      spokePoolPeriphery.address
    );

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount,address exchange,uint8 transferType,uint256 minExpectedInputTokenAmount,uint32 quoteTimestamp,uint32 fillDeadline,bytes32 exclusiveRelayer,uint32 exclusivityParameter,bytes routerCalldata,bool enableProportionalAdjustment,bytes message)",
      ],
      [commitment]
    );
  };

  const buildIntent = async (commitmentData: string): Promise<any> => {
    const latestBlock = await ethers.provider.getBlock("latest");
    const paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const fiatCurrency = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
    const payeeId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    return {
      owner: owner.address,
      to: recipient.address,
      escrow: owner.address,
      depositId: BigNumber.from(1),
      amount: usdc(100),
      timestamp: BigNumber.from(latestBlock.timestamp),
      paymentMethod,
      fiatCurrency,
      conversionRate: BigNumber.from(1_000_000),
      payeeId,
      referrer: ADDRESS_ZERO,
      referrerFee: BigNumber.from(0),
      postIntentHook: hook.address,
      data: commitmentData,
    };
  };

  const buildFulfillData = (overrides: any = {}): { encoded: string; data: any } => {
    const data = {
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      outputAmount: overrides.outputAmount ?? BigNumber.from(1_000_000),
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(["tuple(bytes32 intentHash,uint256 outputAmount)"], [data]);

    return { encoded, data };
  };

  describe("#execute", () => {
    let commitment: any;
    let commitmentData: string;
    let intent: any;
    let amountNetFees: BigNumber;

    beforeEach(async () => {
      commitment = {
        destinationChainId: BigNumber.from(137),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(500_000),
        exchange: exchange.address,
        transferType: 0,
        minExpectedInputTokenAmount: BigNumber.from(5_000_000),
        quoteTimestamp: 0,
        fillDeadline: 3600,
        exclusiveRelayer: ZERO_BYTES32,
        exclusivityParameter: 0,
        routerCalldata: "0x",
        enableProportionalAdjustment: false,
        message: "0x",
      };

      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);
    });

    async function subject(encodedFulfillData: string): Promise<any> {
      return hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encodedFulfillData);
    }

    it("should execute swap and bridge with signal-intent committed minima and route fields", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: BigNumber.from(700_000) });

      await expect(subject(encoded)).to.emit(hook, "AcrossSwapBridgeInitiated");

      expect(await spokePoolPeriphery.lastSpokePool()).to.eq(spokePool.address);
      expect(await spokePoolPeriphery.lastExchange()).to.eq(commitment.exchange);
      expect(await spokePoolPeriphery.lastSwapToken()).to.eq(usdcToken.address);
      expect(await spokePoolPeriphery.lastSwapTokenAmount()).to.eq(amountNetFees);
      expect(await spokePoolPeriphery.lastMinExpectedInputTokenAmount()).to.eq(commitment.minExpectedInputTokenAmount);
      expect(await spokePoolPeriphery.lastTransferType()).to.eq(commitment.transferType);
      expect((await spokePoolPeriphery.lastDepositOutputToken()).toLowerCase()).to.eq(
        commitment.outputToken.toLowerCase()
      );
      expect(await spokePoolPeriphery.lastDepositOutputAmount()).to.eq(data.outputAmount);
      expect((await spokePoolPeriphery.lastDepositRecipient()).toLowerCase()).to.eq(
        commitment.recipient.toLowerCase()
      );
      expect(await spokePoolPeriphery.lastDepositQuoteTimestamp()).to.eq(commitment.quoteTimestamp);
      expect(await spokePoolPeriphery.lastDepositFillDeadline()).to.eq(commitment.fillDeadline);
      expect(await spokePoolPeriphery.lastDepositExclusivityParameter()).to.eq(commitment.exclusivityParameter);
      expect(await spokePoolPeriphery.lastDepositExclusiveRelayer()).to.eq(commitment.exclusiveRelayer);
      expect(await spokePoolPeriphery.lastDepositMessage()).to.eq(commitment.message);
    });

    it("should fallback when outputAmount is below minimum", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: commitment.minOutputAmount.sub(1) });

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      await expect(subject(encoded))
        .to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 0);

      expect(await usdcToken.balanceOf(recipient.address)).to.eq(recipientBalanceBefore.add(amountNetFees));
      expect(await usdcToken.balanceOf(spokePool.address)).to.eq(0);
      expect(await usdcToken.balanceOf(spokePoolPeriphery.address)).to.eq(0);
    });

    it("should fallback when periphery call reverts", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: BigNumber.from(700_000) });

      await spokePoolPeriphery.setShouldRevert(true);

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);
      await expect(subject(encoded))
        .to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 1);

      expect(await usdcToken.balanceOf(recipient.address)).to.eq(recipientBalanceBefore.add(amountNetFees));
      expect(await usdcToken.balanceOf(spokePoolPeriphery.address)).to.eq(0);

      await spokePoolPeriphery.setShouldRevert(false);
    });

    it("should revert when caller is not orchestrator", async () => {
      const { encoded } = buildFulfillData();
      await expect(
        hook.connect(attacker.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should revert when destinationChainId is zero", async () => {
      commitment.destinationChainId = BigNumber.from(0);
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidDestinationChainId");
    });

    it("should revert when recipient is zero bytes32", async () => {
      commitment.recipient = ZERO_BYTES32;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidRecipient");
    });

    it("should revert when outputToken is zero bytes32", async () => {
      commitment.outputToken = ZERO_BYTES32;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidOutputToken");
    });

    it("should revert when exchange is zero address", async () => {
      commitment.exchange = ADDRESS_ZERO;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidExchange");
    });

    it("should revert when transferType is invalid", async () => {
      commitment.transferType = 99;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidTransferType");
    });

    it("should revert when minExpectedInputTokenAmount is zero", async () => {
      commitment.minExpectedInputTokenAmount = BigNumber.from(0);
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidMinExpectedInputTokenAmount");
    });
  });
});
