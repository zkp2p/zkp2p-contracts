import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { ADDRESS_ZERO, ZERO_BYTES32 } from "@utils/constants";

const expect = getWaffleExpect();

describe("AcrossBridgeHookV2", () => {
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

  // Helper to convert address to bytes32 (left-padded)
  const toBytes32 = (addr: string): string => {
    return ethers.utils.hexZeroPad(addr, 32);
  };

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

    const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
    hook = await AcrossBridgeHookV2.deploy(
      usdcToken.address,
      orchestrator.address,
      spokePool.address,
      spokePoolPeriphery.address,
      [exchange.address]
    );

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  const encodeCommitment = (commitment: any): string => {
    const modeData = ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount)"],
      [commitment]
    );

    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint8 mode, bytes modeData)"],
      [[0, modeData]]
    );
  };

  const encodeSwapAndBridgeCommitment = (commitment: any): string => {
    const modeData = ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount)"],
      [commitment]
    );

    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint8 mode, bytes modeData)"],
      [[1, modeData]]
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
      fillDeadlineOffset: overrides.fillDeadlineOffset ?? 21600,  // 6 hours default
      exclusiveRelayer: overrides.exclusiveRelayer ?? toBytes32("0x1562A70707D62edBF3a90317E46E1DF075E2d924"),  // Sample relayer from Across
      exclusivityParameter: overrides.exclusivityParameter ?? 5  // 5 seconds exclusivity (typical Across value)
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 intentHash,uint256 outputAmount,uint32 fillDeadlineOffset,bytes32 exclusiveRelayer,uint32 exclusivityParameter)"],
      [data]
    );

    return { encoded, data };
  };

  const buildSwapFulfillData = (overrides: any = {}): { encoded: string; data: any } => {
    const data = {
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      outputAmount: overrides.outputAmount ?? BigNumber.from(1_000_000),
      bridgeInputToken: overrides.bridgeInputToken ?? usdcToken.address,
      exchange: overrides.exchange ?? exchange.address,
      transferType: overrides.transferType ?? 0,
      minExpectedInputTokenAmount: overrides.minExpectedInputTokenAmount ?? BigNumber.from(50_000),
      quoteTimestamp: overrides.quoteTimestamp ?? 3600,
      fillDeadline: overrides.fillDeadline ?? 21600,
      exclusiveRelayer: overrides.exclusiveRelayer ?? toBytes32("0x1562A70707D62edBF3a90317E46E1DF075E2d924"),
      exclusivityParameter: overrides.exclusivityParameter ?? 5,
      routerCalldata: overrides.routerCalldata ?? "0x",
      enableProportionalAdjustment: overrides.enableProportionalAdjustment ?? false,
      message: overrides.message ?? "0x",
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32 intentHash,uint256 outputAmount,address bridgeInputToken,address exchange,uint8 transferType,uint256 minExpectedInputTokenAmount,uint32 quoteTimestamp,uint32 fillDeadline,bytes32 exclusiveRelayer,uint32 exclusivityParameter,bytes routerCalldata,bool enableProportionalAdjustment,bytes message)"
      ],
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
        outputToken: toBytes32(recipient.address),  // Using bytes32
        recipient: toBytes32(recipient.address),     // Using bytes32
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

    it("should execute bridge-only with valid parameters", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: BigNumber.from(700_000) });

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject(encoded)).to.emit(hook, "AcrossBridgeInitiated");

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(amountNetFees);
      expect(hookBalance).to.eq(0);
      expect(spokePoolBalance).to.eq(amountNetFees);

      // Verify mock received correct bytes32 values (use toLowerCase for hex comparison)
      expect((await spokePool.lastRecipient()).toLowerCase()).to.eq(commitment.recipient.toLowerCase());
      expect((await spokePool.lastInputToken()).toLowerCase()).to.eq(toBytes32(usdcToken.address).toLowerCase());
      expect((await spokePool.lastOutputToken()).toLowerCase()).to.eq(commitment.outputToken.toLowerCase());
      expect(await spokePool.lastInputAmount()).to.eq(amountNetFees);
      expect(await spokePool.lastOutputAmount()).to.eq(data.outputAmount);
      expect(await spokePool.lastDestinationChainId()).to.eq(commitment.destinationChainId);
      expect(await spokePool.lastFillDeadlineOffset()).to.eq(data.fillDeadlineOffset);
      expect((await spokePool.lastExclusiveRelayer()).toLowerCase()).to.eq(data.exclusiveRelayer.toLowerCase());
      expect(await spokePool.lastExclusivityParameter()).to.eq(data.exclusivityParameter);
    });

      it("should execute swap-and-bridge mode", async () => {
      commitmentData = encodeSwapAndBridgeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded, data } = buildSwapFulfillData({
        exchange: exchange.address,
        outputAmount: BigNumber.from(700_000),
      });

      await expect(subject(encoded)).to.emit(hook, "AcrossSwapAndBridgeInitiated");

      expect(await spokePoolPeriphery.lastExchange()).to.eq(exchange.address);
      expect(await spokePoolPeriphery.lastSwapToken()).to.eq(usdcToken.address);
      expect(await spokePoolPeriphery.lastSwapTokenAmount()).to.eq(amountNetFees);
      expect(await spokePoolPeriphery.lastMinExpectedInputTokenAmount()).to.eq(data.minExpectedInputTokenAmount);
      expect(await spokePoolPeriphery.lastTransferType()).to.eq(data.transferType);
    });

    it("should fallback for swap-and-bridge when periphery reverts", async () => {
      commitmentData = encodeSwapAndBridgeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded, data } = buildSwapFulfillData({
        exchange: exchange.address,
        outputAmount: BigNumber.from(700_000),
      });

      await spokePoolPeriphery.setShouldRevert(true);

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);
      await expect(subject(encoded))
        .to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 2);
      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(amountNetFees);
      await spokePoolPeriphery.setShouldRevert(false);
    });

    it("should revert when caller is not orchestrator", async () => {
      const { encoded } = buildFulfillData();

      await expect(
        hook.connect(attacker.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should fallback to direct transfer when outputAmount is below minimum", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: commitment.minOutputAmount.sub(1) });

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);
      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      // Should emit FallbackTransfer with OUTPUT_BELOW_MINIMUM reason (enum value 0)
      await expect(subject(encoded))
        .to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 0);

      // Verify funds went to recipient (intent.to), not spokePool
      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(amountNetFees);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(amountNetFees);
      expect(hookBalance).to.eq(0);
      expect(spokePoolBalance).to.eq(0);
    });

    it("should fallback to direct transfer when bridge call reverts", async () => {
      const { encoded, data } = buildFulfillData({ outputAmount: BigNumber.from(700_000) });

      // Make the mock revert
      await spokePool.setShouldRevert(true);

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      // Should emit FallbackTransfer with BRIDGE_CALL_FAILED reason (enum value 1)
      await expect(subject(encoded))
        .to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 1);

      // Verify funds went to recipient, not spokePool
      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(amountNetFees);
      expect(spokePoolBalance).to.eq(0);

      // Reset mock for other tests
      await spokePool.setShouldRevert(false);
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

    it("should revert swap-and-bridge when exchange is not allowed", async () => {
      commitmentData = encodeSwapAndBridgeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const disallowedExchange = attacker.address;
      const { encoded } = buildSwapFulfillData({ exchange: disallowedExchange });

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "ExchangeNotAllowed");
    });

    it("should revert swap-and-bridge when minExpectedInputTokenAmount is zero", async () => {
      commitmentData = encodeSwapAndBridgeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildSwapFulfillData({
        exchange: exchange.address,
        minExpectedInputTokenAmount: BigNumber.from(0),
      });

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidMinExpectedInputTokenAmount");
    });
  });

  describe("#constructor: constructor-initialized allowlist", () => {
    it("should initialize exchange allowlist from constructor", async () => {
      expect(await hook.allowedExchanges(exchange.address)).to.eq(true);
    });
  });

  describe("#constructor", () => {
    it("should set immutable variables correctly", async () => {
      expect(await hook.inputToken()).to.eq(usdcToken.address);
      expect(await hook.orchestrator()).to.eq(orchestrator.address);
      expect(await hook.spokePool()).to.eq(spokePool.address);
    });

    it("should revert when inputToken is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(ADDRESS_ZERO, orchestrator.address, spokePool.address, spokePoolPeriphery.address, [exchange.address])
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when orchestrator is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, ADDRESS_ZERO, spokePool.address, spokePoolPeriphery.address, [exchange.address])
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when spokePool is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, ADDRESS_ZERO, spokePoolPeriphery.address, [exchange.address])
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when spokePoolPeriphery is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, spokePool.address, ADDRESS_ZERO, [exchange.address])
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when an allowed exchange is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, spokePool.address, spokePoolPeriphery.address, [ADDRESS_ZERO])
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should set owner to deployer", async () => {
      expect(await hook.owner()).to.eq(owner.address);
    });
  });

  describe("#rescueERC20", () => {
    let stuckToken: Contract;

    beforeEach(async () => {
      stuckToken = await deployer.deployUSDCMock(usdc(1000), "STUCK", "STUCK");
      await stuckToken.transfer(hook.address, usdc(100));
    });

    it("should rescue ERC20 tokens to recipient", async () => {
      const recipientBalanceBefore = await stuckToken.balanceOf(recipient.address);

      await expect(hook.connect(owner.wallet).rescueERC20(stuckToken.address, recipient.address, usdc(100)))
        .to.emit(hook, "RescueERC20")
        .withArgs(stuckToken.address, recipient.address, usdc(100));

      const recipientBalanceAfter = await stuckToken.balanceOf(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(usdc(100));
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        hook.connect(attacker.wallet).rescueERC20(stuckToken.address, recipient.address, usdc(100))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when token address is zero", async () => {
      await expect(
        hook.connect(owner.wallet).rescueERC20(ADDRESS_ZERO, recipient.address, usdc(100))
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when recipient address is zero", async () => {
      await expect(
        hook.connect(owner.wallet).rescueERC20(stuckToken.address, ADDRESS_ZERO, usdc(100))
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });
  });

  describe("#rescueNative", () => {
    beforeEach(async () => {
      await owner.wallet.sendTransaction({
        to: hook.address,
        value: ether(1)
      });
    });

    it("should rescue native tokens to recipient", async () => {
      const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

      await expect(hook.connect(owner.wallet).rescueNative(recipient.address, ether(1)))
        .to.emit(hook, "RescueNative")
        .withArgs(recipient.address, ether(1));

      const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(ether(1));
    });

    it("should revert when called by non-owner", async () => {
      await expect(
        hook.connect(attacker.wallet).rescueNative(recipient.address, ether(1))
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when recipient address is zero", async () => {
      await expect(
        hook.connect(owner.wallet).rescueNative(ADDRESS_ZERO, ether(1))
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should allow partial rescue", async () => {
      await expect(hook.connect(owner.wallet).rescueNative(recipient.address, ether(0.5)))
        .to.emit(hook, "RescueNative")
        .withArgs(recipient.address, ether(0.5));

      const hookBalance = await ethers.provider.getBalance(hook.address);
      expect(hookBalance).to.eq(ether(0.5));
    });
  });

  describe("#receive", () => {
    it("should accept native token transfers", async () => {
      await owner.wallet.sendTransaction({
        to: hook.address,
        value: ether(1)
      });

      const hookBalance = await ethers.provider.getBalance(hook.address);
      expect(hookBalance).to.eq(ether(1));
    });
  });
});
