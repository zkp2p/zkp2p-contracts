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
  let usdtToken: Contract;
  let spokePool: Contract;
  let spokePoolPeriphery: Contract;
  let hook: Contract;

  const toBytes32 = (addr: string): string => ethers.utils.hexZeroPad(addr, 32);

  beforeEach(async () => {
    [owner, orchestrator, recipient, attacker, exchange] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    usdtToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDT", "USDT");

    const AcrossSpokePoolMock = await ethers.getContractFactory("AcrossSpokePoolMock", owner.wallet);
    spokePool = await AcrossSpokePoolMock.deploy();

    const AcrossSpokePoolPeripheryMock = await ethers.getContractFactory("AcrossSpokePoolPeripheryMock", owner.wallet);
    spokePoolPeriphery = await AcrossSpokePoolPeripheryMock.deploy();

    const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
    hook = await AcrossBridgeHookV2.deploy(
      usdcToken.address,
      orchestrator.address,
      spokePool.address,
      spokePoolPeriphery.address
    );

    await hook.connect(owner.wallet).setExchangeAllowed(exchange.address, true);
    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

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

  const encodeBridgeCommitmentPayload = (commitment: any): string =>
    ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount)"],
      [commitment]
    );

  const encodeBridgeCommitmentEnvelope = (commitment: any): string =>
    ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint8 mode,bytes modeData)"],
      [{ mode: 0, modeData: encodeBridgeCommitmentPayload(commitment) }]
    );

  const buildLegacyBridgeFulfillData = (overrides: any = {}): { encoded: string; data: any } => {
    const data = {
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      outputAmount: overrides.outputAmount ?? BigNumber.from(1_000_000),
      fillDeadlineOffset: overrides.fillDeadlineOffset ?? 21600,
      exclusiveRelayer: overrides.exclusiveRelayer ?? toBytes32("0x1562A70707D62edBF3a90317E46E1DF075E2d924"),
      exclusivityParameter: overrides.exclusivityParameter ?? 5
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 intentHash,uint256 outputAmount,uint32 fillDeadlineOffset,bytes32 exclusiveRelayer,uint32 exclusivityParameter)"],
      [data]
    );
    return { encoded, data };
  };

  const encodeSwapCommitmentEnvelope = (commitment: any): string => {
    const modeData = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount)"
      ],
      [commitment]
    );

    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint8 mode,bytes modeData)"],
      [{ mode: 1, modeData }]
    );
  };

  const buildSwapAndBridgeFulfillData = (overrides: any = {}): { encoded: string; data: any } => {
    const data = {
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32)),
      outputAmount: overrides.outputAmount ?? BigNumber.from(980_000),
      bridgeInputToken: overrides.bridgeInputToken ?? usdtToken.address,
      exchange: overrides.exchange ?? exchange.address,
      transferType: overrides.transferType ?? 0,
      minExpectedInputTokenAmount: overrides.minExpectedInputTokenAmount ?? BigNumber.from(999_000),
      quoteTimestamp: overrides.quoteTimestamp ?? 1_770_992_207,
      fillDeadline: overrides.fillDeadline ?? 1_770_999_407,
      exclusiveRelayer: overrides.exclusiveRelayer ?? toBytes32("0x15652636f3898f550b257b89926d5566821c32e1"),
      exclusivityParameter: overrides.exclusivityParameter ?? 5,
      routerCalldata: overrides.routerCalldata ?? "0x1234abcd",
      enableProportionalAdjustment: overrides.enableProportionalAdjustment ?? true,
      message: overrides.message ?? "0x"
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(bytes32 intentHash,uint256 outputAmount,address bridgeInputToken,address exchange,uint8 transferType,uint256 minExpectedInputTokenAmount,uint32 quoteTimestamp,uint32 fillDeadline,bytes32 exclusiveRelayer,uint32 exclusivityParameter,bytes routerCalldata,bool enableProportionalAdjustment,bytes message)"
      ],
      [data]
    );
    return { encoded, data };
  };

  describe("#execute bridge-only mode", () => {
    it("should execute bridge-only mode when explicit BRIDGE_ONLY envelope is supplied", async () => {
      const commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(500_000)
      };
      const intent = await buildIntent(encodeBridgeCommitmentEnvelope(commitment));
      const { encoded, data } = buildLegacyBridgeFulfillData({ outputAmount: BigNumber.from(700_000) });
      const amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encoded)
      ).to.emit(hook, "AcrossBridgeInitiated");

      expect(await spokePool.lastInputAmount()).to.eq(amountNetFees);
      expect((await spokePool.lastInputToken()).toLowerCase()).to.eq(toBytes32(usdcToken.address).toLowerCase());
      expect((await spokePool.lastOutputToken()).toLowerCase()).to.eq(commitment.outputToken.toLowerCase());
    });

    it("should revert when legacy raw bridge commitment payload is supplied without envelope", async () => {
      const commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(500_000)
      };
      const intent = await buildIntent(encodeBridgeCommitmentPayload(commitment));
      const { encoded } = buildLegacyBridgeFulfillData({ outputAmount: BigNumber.from(700_000) });

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, usdc(50));
      await expect(
        hook.connect(orchestrator.wallet).execute(intent, usdc(50), encoded)
      ).to.be.reverted;
    });
  });

  describe("#execute swap-and-bridge mode", () => {
    it("should execute swap+bridge through periphery in one hook", async () => {
      const routerCalldata = "0xaabbccdd1122";
      const swapCommitment = {
        destinationChainId: BigNumber.from(137),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(900_000)
      };
      const intent = await buildIntent(encodeSwapCommitmentEnvelope(swapCommitment));
      const { encoded, data } = buildSwapAndBridgeFulfillData({
        outputAmount: BigNumber.from(950_000),
        minExpectedInputTokenAmount: BigNumber.from(999_000),
        routerCalldata
      });
      const amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encoded)
      ).to.emit(hook, "AcrossSwapAndBridgeInitiated");

      expect(await spokePoolPeriphery.lastSwapToken()).to.eq(usdcToken.address);
      expect(await spokePoolPeriphery.lastDepositInputToken()).to.eq(usdtToken.address);
      expect(await spokePoolPeriphery.lastExchange()).to.eq(exchange.address);
      expect(await spokePoolPeriphery.lastSwapTokenAmount()).to.eq(amountNetFees);
      expect(await spokePoolPeriphery.lastMinExpectedInputTokenAmount()).to.eq(data.minExpectedInputTokenAmount);
      expect((await spokePoolPeriphery.lastDepositOutputToken()).toLowerCase()).to.eq(swapCommitment.outputToken.toLowerCase());
      expect(await spokePoolPeriphery.lastDepositDestinationChainId()).to.eq(swapCommitment.destinationChainId);
      expect(await usdcToken.balanceOf(spokePoolPeriphery.address)).to.eq(amountNetFees);
    });

    it("should fallback to direct transfer when swap+bridge call reverts", async () => {
      const routerCalldata = "0xaabbccdd1122";
      const swapCommitment = {
        destinationChainId: BigNumber.from(137),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(900_000)
      };
      const intent = await buildIntent(encodeSwapCommitmentEnvelope(swapCommitment));
      const { encoded, data } = buildSwapAndBridgeFulfillData({
        outputAmount: BigNumber.from(950_000),
        minExpectedInputTokenAmount: BigNumber.from(999_000),
        routerCalldata
      });
      const amountNetFees = usdc(50);

      await spokePoolPeriphery.connect(owner.wallet).setShouldRevert(true);
      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encoded)
      ).to.emit(hook, "FallbackTransfer")
        .withArgs(data.intentHash, recipient.address, amountNetFees, 2);

      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(amountNetFees);
    });

    it("should revert when swap exchange is not allowed", async () => {
      const disallowedExchange = attacker.address;
      const routerCalldata = "0xaabbccdd1122";
      const swapCommitment = {
        destinationChainId: BigNumber.from(137),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(900_000)
      };
      const intent = await buildIntent(encodeSwapCommitmentEnvelope(swapCommitment));
      const { encoded } = buildSwapAndBridgeFulfillData({ routerCalldata, exchange: disallowedExchange });
      const amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "ExchangeNotAllowed");
    });

    it("should revert when transferType is invalid", async () => {
      const swapCommitment = {
        destinationChainId: BigNumber.from(137),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(900_000)
      };
      const intent = await buildIntent(encodeSwapCommitmentEnvelope(swapCommitment));
      const { encoded } = buildSwapAndBridgeFulfillData({ transferType: 3 });
      const amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "InvalidTransferType");
    });
  });

  describe("#constructor", () => {
    it("should set immutable variables correctly", async () => {
      expect(await hook.inputToken()).to.eq(usdcToken.address);
      expect(await hook.orchestrator()).to.eq(orchestrator.address);
      expect(await hook.spokePool()).to.eq(spokePool.address);
      expect(await hook.spokePoolPeriphery()).to.eq(spokePoolPeriphery.address);
    });

    it("should revert when any constructor address is zero", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(ADDRESS_ZERO, orchestrator.address, spokePool.address, spokePoolPeriphery.address)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, ADDRESS_ZERO, spokePool.address, spokePoolPeriphery.address)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, ADDRESS_ZERO, spokePoolPeriphery.address)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, spokePool.address, ADDRESS_ZERO)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });
  });

  describe("#setExchangeAllowed", () => {
    it("should update allowed exchange when called by owner", async () => {
      await expect(hook.connect(owner.wallet).setExchangeAllowed(attacker.address, true))
        .to.emit(hook, "ExchangeAllowedUpdated")
        .withArgs(attacker.address, true);

      expect(await hook.allowedExchanges(attacker.address)).to.eq(true);
    });

    it("should revert for non-owner", async () => {
      await expect(
        hook.connect(attacker.wallet).setExchangeAllowed(exchange.address, false)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when exchange is zero address", async () => {
      await expect(
        hook.connect(owner.wallet).setExchangeAllowed(ADDRESS_ZERO, true)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });
  });

  describe("#rescue functions", () => {
    it("should rescue ERC20 tokens", async () => {
      await usdcToken.transfer(hook.address, usdc(10));
      await expect(
        hook.connect(owner.wallet).rescueERC20(usdcToken.address, recipient.address, usdc(10))
      ).to.emit(hook, "RescueERC20").withArgs(usdcToken.address, recipient.address, usdc(10));
    });

    it("should rescue native tokens", async () => {
      await owner.wallet.sendTransaction({ to: hook.address, value: ether(1) });
      await expect(
        hook.connect(owner.wallet).rescueNative(recipient.address, ether(1))
      ).to.emit(hook, "RescueNative").withArgs(recipient.address, ether(1));
    });

    it("should revert native rescue on zero recipient", async () => {
      await expect(
        hook.connect(owner.wallet).rescueNative(ADDRESS_ZERO, ether(1))
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });
  });

  describe("#authorization", () => {
    it("should revert when execute caller is not orchestrator", async () => {
      const commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(1)
      };
      const intent = await buildIntent(encodeBridgeCommitmentEnvelope(commitment));
      const { encoded } = buildLegacyBridgeFulfillData();

      await expect(
        hook.connect(attacker.wallet).execute(intent, usdc(1), encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should revert on invalid output token in legacy bridge mode", async () => {
      const commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: ZERO_BYTES32,
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(1)
      };
      const intent = await buildIntent(encodeBridgeCommitmentEnvelope(commitment));
      const { encoded } = buildLegacyBridgeFulfillData();
      await usdcToken.connect(orchestrator.wallet).approve(hook.address, usdc(1));

      await expect(
        hook.connect(orchestrator.wallet).execute(intent, usdc(1), encoded)
      ).to.be.revertedWithCustomError(hook, "InvalidOutputToken");
    });
  });
});
