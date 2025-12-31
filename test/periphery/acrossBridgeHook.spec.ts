import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { ADDRESS_ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("AcrossBridgeHook", () => {
  let owner: Account;
  let orchestrator: Account;
  let recipient: Account;
  let attacker: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let spokePool: Contract;
  let hook: Contract;

  const currentTime = BigNumber.from(1_700_000_000);
  const quoteBuffer = BigNumber.from(300);
  const fillBuffer = BigNumber.from(3600);

  beforeEach(async () => {
    [owner, orchestrator, recipient, attacker] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const AcrossSpokePoolMock = await ethers.getContractFactory("AcrossSpokePoolMock", owner.wallet);
    spokePool = await AcrossSpokePoolMock.deploy();

    const AcrossBridgeHook = await ethers.getContractFactory("AcrossBridgeHook", owner.wallet);
    hook = await AcrossBridgeHook.deploy(usdcToken.address, orchestrator.address, spokePool.address);

    await spokePool.setCurrentTime(currentTime);
    await spokePool.setBuffers(quoteBuffer, fillBuffer);

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,address outputToken,address recipient,uint256 minOutputAmount)"],
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
      paymentMethod: paymentMethod,
      fiatCurrency: fiatCurrency,
      conversionRate: ether(1),
      payeeId: payeeId,
      referrer: ADDRESS_ZERO,
      referrerFee: BigNumber.from(0),
      postIntentHook: hook.address,
      data: commitmentData
    };
  };

  const buildFulfillData = (overrides: any = {}): { encoded: string; data: any } => {
    const data = {
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      outputAmount: overrides.outputAmount ?? BigNumber.from(1_000_000),
      quoteTimestamp: overrides.quoteTimestamp ?? currentTime,
      fillDeadline: overrides.fillDeadline ?? currentTime.add(1000)
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 intentHash,uint256 outputAmount,uint32 quoteTimestamp,uint32 fillDeadline)"],
      [data]
    );

    return { encoded, data };
  };

  describe("#execute", () => {
    let commitment: any;
    let commitmentData: string;
    let intent: any;
    let amountNetFees: BigNumber;

    beforeEach(async () => {
      commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: recipient.address,
        recipient: recipient.address,
        minOutputAmount: BigNumber.from(500_000)
      };

      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);
    });

    async function subject(encodedFulfillData: string): Promise<any> {
      return hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encodedFulfillData);
    }

    it("should execute with a valid quote", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: BigNumber.from(700_000) });

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject(encoded)).to.emit(hook, "AcrossBridgeInitiated").withArgs(
        data.intentHash,
        commitment.destinationChainId,
        commitment.outputToken,
        commitment.recipient,
        amountNetFees,
        data.outputAmount,
        data.quoteTimestamp,
        data.fillDeadline
      );

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(amountNetFees);
      expect(hookBalance).to.eq(0);
      expect(spokePoolBalance).to.eq(amountNetFees);

      expect(await spokePool.lastRecipient()).to.eq(commitment.recipient);
      expect(await spokePool.lastInputToken()).to.eq(usdcToken.address);
      expect(await spokePool.lastInputAmount()).to.eq(amountNetFees);
      expect(await spokePool.lastDestinationChainId()).to.eq(commitment.destinationChainId);
    });

    it("should revert when caller is not orchestrator", async () => {
      const { encoded } = buildFulfillData();

      await expect(
        hook.connect(attacker.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should revert when outputAmount is below minimum", async () => {
      const { encoded } = buildFulfillData({ outputAmount: commitment.minOutputAmount.sub(1) });

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "OutputBelowMinimum");
    });

    it("should revert when destinationChainId is zero", async () => {
      commitment.destinationChainId = BigNumber.from(0);
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidDestinationChainId");
    });

    it("should revert when recipient is zero", async () => {
      commitment.recipient = ADDRESS_ZERO;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidRecipient");
    });

    it("should revert when outputToken is zero", async () => {
      commitment.outputToken = ADDRESS_ZERO;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidOutputToken");
    });

    it("should revert when quoteTimestamp is out of range", async () => {
      const tooOld = currentTime.sub(quoteBuffer).sub(1);
      const { encoded } = buildFulfillData({ quoteTimestamp: tooOld });

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "QuoteTimestampOutOfRange");
    });

    it("should revert when fillDeadline is out of range", async () => {
      const { encoded } = buildFulfillData({ fillDeadline: currentTime.sub(1) });

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "FillDeadlineOutOfRange");
    });
  });
});
