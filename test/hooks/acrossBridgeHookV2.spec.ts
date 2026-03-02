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

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let spokePool: Contract;
  let orchestratorRegistry: Contract;
  let hook: Contract;

  // Helper to convert address to bytes32 (left-padded)
  const toBytes32 = (addr: string): string => {
    return ethers.utils.hexZeroPad(addr, 32);
  };

  // Encode BridgeCommitment struct for signalHookData
  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,bytes32 outputToken,bytes32 recipient,uint256 minOutputAmount)"],
      [commitment]
    );
  };

  // Encode V2 AcrossFulfillData (no intentHash -- exactly 128 bytes)
  const encodeFulfillData = (data: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 outputAmount,uint32 fillDeadlineOffset,bytes32 exclusiveRelayer,uint32 exclusivityParameter)"],
      [data]
    );
  };

  // Build HookExecutionContext for V2 execute
  const buildContext = (commitment: any, overrides: any = {}): any => {
    const intentHash = overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32));
    return {
      intentHash,
      token: usdcToken.address,
      executableAmount: overrides.executableAmount ?? usdc(50),
      intent: {
        owner: owner.address,
        to: overrides.to ?? recipient.address,
        escrow: owner.address,
        depositId: BigNumber.from(1),
        amount: usdc(100),
        timestamp: overrides.timestamp ?? BigNumber.from(Math.floor(Date.now() / 1000)),
        paymentMethod: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo")),
        fiatCurrency: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD")),
        conversionRate: ether(1),
        payeeId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee")),
        signalHookData: encodeCommitment(commitment),
      }
    };
  };

  beforeEach(async () => {
    [owner, orchestrator, recipient, attacker] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const AcrossSpokePoolMock = await ethers.getContractFactory("AcrossSpokePoolMock", owner.wallet);
    spokePool = await AcrossSpokePoolMock.deploy();

    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    await orchestratorRegistry.addOrchestrator(orchestrator.address);

    const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
    hook = await AcrossBridgeHookV2.deploy(usdcToken.address, orchestratorRegistry.address, spokePool.address);

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  describe("#constructor", () => {
    it("should set initial variables correctly", async () => {
      expect(await hook.inputToken()).to.eq(usdcToken.address);
      expect(await hook.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
      expect(await hook.spokePool()).to.eq(spokePool.address);
    });

    it("should revert when inputToken is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(ADDRESS_ZERO, orchestratorRegistry.address, spokePool.address)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when orchestratorRegistry is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, ADDRESS_ZERO, spokePool.address)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when spokePool is zero address", async () => {
      const AcrossBridgeHookV2 = await ethers.getContractFactory("AcrossBridgeHookV2", owner.wallet);
      await expect(
        AcrossBridgeHookV2.deploy(usdcToken.address, orchestrator.address, ADDRESS_ZERO)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should set owner to deployer", async () => {
      expect(await hook.owner()).to.eq(owner.address);
    });
  });

  describe("#execute", () => {
    let subjectCaller: Account;
    let subjectCtx: any;
    let subjectFulfillHookData: string;

    let commitment: any;
    let fulfillData: any;

    beforeEach(async () => {
      commitment = {
        destinationChainId: BigNumber.from(10),
        outputToken: toBytes32(recipient.address),
        recipient: toBytes32(recipient.address),
        minOutputAmount: BigNumber.from(500_000)
      };

      fulfillData = {
        outputAmount: BigNumber.from(700_000),
        fillDeadlineOffset: 21600,
        exclusiveRelayer: toBytes32("0x1562A70707D62edBF3a90317E46E1DF075E2d924"),
        exclusivityParameter: 5
      };

      subjectCtx = buildContext(commitment);
      subjectFulfillHookData = encodeFulfillData(fulfillData);
      subjectCaller = orchestrator;

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, subjectCtx.executableAmount);
    });

    async function subject(): Promise<any> {
      return hook.connect(subjectCaller.wallet).execute(subjectCtx, subjectFulfillHookData);
    }

    it("should bridge successfully with valid parameters", async () => {
      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject()).to.emit(hook, "AcrossBridgeInitiated");

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(subjectCtx.executableAmount);
      expect(hookBalance).to.eq(0);
      expect(spokePoolBalance).to.eq(subjectCtx.executableAmount);

      // Verify mock received correct bytes32 values (use toLowerCase for hex comparison)
      expect((await spokePool.lastRecipient()).toLowerCase()).to.eq(commitment.recipient.toLowerCase());
      expect((await spokePool.lastInputToken()).toLowerCase()).to.eq(toBytes32(usdcToken.address).toLowerCase());
      expect((await spokePool.lastOutputToken()).toLowerCase()).to.eq(commitment.outputToken.toLowerCase());
      expect(await spokePool.lastInputAmount()).to.eq(subjectCtx.executableAmount);
      expect(await spokePool.lastOutputAmount()).to.eq(fulfillData.outputAmount);
      expect(await spokePool.lastDestinationChainId()).to.eq(commitment.destinationChainId);
      expect(await spokePool.lastFillDeadlineOffset()).to.eq(fulfillData.fillDeadlineOffset);
      expect((await spokePool.lastExclusiveRelayer()).toLowerCase()).to.eq(fulfillData.exclusiveRelayer.toLowerCase());
      expect(await spokePool.lastExclusivityParameter()).to.eq(fulfillData.exclusivityParameter);
    });

    it("should revert when caller is not a registered orchestrator", async () => {
      subjectCaller = attacker;

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "UnauthorizedOrchestratorCaller");
    });

    it("should revert when fulfillHookData length is not 128", async () => {
      // Encode data with an extra field to produce wrong length
      subjectFulfillHookData = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint32", "bytes32"],
        [BigNumber.from(700_000), 21600, toBytes32(recipient.address)]
      );

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "InvalidFulfillHookDataLength");
    });

    it("should revert when fulfillHookData is empty", async () => {
      subjectFulfillHookData = "0x";

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "InvalidFulfillHookDataLength");
    });

    it("should revert when destinationChainId is zero", async () => {
      commitment.destinationChainId = BigNumber.from(0);
      subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "InvalidDestinationChainId");
    });

    it("should revert when recipient is zero bytes32", async () => {
      commitment.recipient = ZERO_BYTES32;
      subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "InvalidRecipient");
    });

    it("should revert when outputToken is zero bytes32", async () => {
      commitment.outputToken = ZERO_BYTES32;
      subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });

      await expect(subject())
        .to.be.revertedWithCustomError(hook, "InvalidOutputToken");
    });

    it("should fallback when outputAmount is below minOutputAmount", async () => {
      const intentHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      fulfillData.outputAmount = commitment.minOutputAmount.sub(1);
      subjectFulfillHookData = encodeFulfillData(fulfillData);
      subjectCtx = buildContext(commitment, { intentHash });

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, subjectCtx.executableAmount);

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);
      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      // FallbackReason.OUTPUT_BELOW_MINIMUM = 0
      await expect(subject())
        .to.emit(hook, "FallbackTransfer")
        .withArgs(intentHash, recipient.address, subjectCtx.executableAmount, 0);

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(subjectCtx.executableAmount);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(subjectCtx.executableAmount);
      expect(hookBalance).to.eq(0);
      expect(spokePoolBalance).to.eq(0);
    });

    it("should fallback when bridge call reverts", async () => {
      const intentHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      subjectCtx = buildContext(commitment, { intentHash });
      subjectFulfillHookData = encodeFulfillData(fulfillData);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, subjectCtx.executableAmount);

      // Make the mock revert
      await spokePool.setShouldRevert(true);

      const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

      // FallbackReason.BRIDGE_CALL_FAILED = 1
      await expect(subject())
        .to.emit(hook, "FallbackTransfer")
        .withArgs(intentHash, recipient.address, subjectCtx.executableAmount, 1);

      const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
      const spokePoolBalance = await usdcToken.balanceOf(spokePool.address);

      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(subjectCtx.executableAmount);
      expect(spokePoolBalance).to.eq(0);
    });

    it("should succeed when outputAmount equals minOutputAmount exactly", async () => {
      fulfillData.outputAmount = commitment.minOutputAmount;
      subjectFulfillHookData = encodeFulfillData(fulfillData);

      await expect(subject()).to.emit(hook, "AcrossBridgeInitiated");
    });

    it("should work with different fillDeadlineOffset values", async () => {
      const shortOffset = 1800; // 30 minutes
      fulfillData.fillDeadlineOffset = shortOffset;
      subjectFulfillHookData = encodeFulfillData(fulfillData);

      await expect(subject()).to.emit(hook, "AcrossBridgeInitiated");
      expect(await spokePool.lastFillDeadlineOffset()).to.eq(shortOffset);
    });

    it("should pass custom exclusiveRelayer and exclusivityParameter to spokePool", async () => {
      const customRelayer = toBytes32("0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef");
      const customExclusivity = 10;

      fulfillData.exclusiveRelayer = customRelayer;
      fulfillData.exclusivityParameter = customExclusivity;
      subjectFulfillHookData = encodeFulfillData(fulfillData);

      await subject();

      expect((await spokePool.lastExclusiveRelayer()).toLowerCase()).to.eq(customRelayer.toLowerCase());
      expect(await spokePool.lastExclusivityParameter()).to.eq(customExclusivity);
    });

    it("should work with zero exclusivity (open relay)", async () => {
      fulfillData.exclusiveRelayer = ZERO_BYTES32;
      fulfillData.exclusivityParameter = 0;
      subjectFulfillHookData = encodeFulfillData(fulfillData);

      await expect(subject()).to.emit(hook, "AcrossBridgeInitiated");
      expect(await spokePool.lastExclusiveRelayer()).to.eq(ZERO_BYTES32);
      expect(await spokePool.lastExclusivityParameter()).to.eq(0);
    });

    it("should correctly convert depositor (hook address) to bytes32", async () => {
      await subject();

      const lastDepositor = (await spokePool.lastDepositor()).toLowerCase();
      const expectedDepositor = toBytes32(hook.address).toLowerCase();
      expect(lastDepositor).to.eq(expectedDepositor);
    });
  });

  describe("#rescueERC20", () => {
    let subjectCaller: Account;
    let subjectToken: string;
    let subjectTo: string;
    let subjectAmount: BigNumber;

    let stuckToken: Contract;

    beforeEach(async () => {
      stuckToken = await deployer.deployUSDCMock(usdc(1000), "STUCK", "STUCK");
      await stuckToken.transfer(hook.address, usdc(100));

      subjectCaller = owner;
      subjectToken = stuckToken.address;
      subjectTo = recipient.address;
      subjectAmount = usdc(100);
    });

    async function subject(): Promise<any> {
      return hook.connect(subjectCaller.wallet).rescueERC20(subjectToken, subjectTo, subjectAmount);
    }

    it("should rescue ERC20 tokens to recipient", async () => {
      const recipientBalanceBefore = await stuckToken.balanceOf(recipient.address);

      await expect(subject())
        .to.emit(hook, "RescueERC20")
        .withArgs(stuckToken.address, recipient.address, usdc(100));

      const recipientBalanceAfter = await stuckToken.balanceOf(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(usdc(100));
    });

    it("should revert when called by non-owner", async () => {
      subjectCaller = attacker;

      await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when token address is zero", async () => {
      subjectToken = ADDRESS_ZERO;

      await expect(subject()).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when recipient address is zero", async () => {
      subjectTo = ADDRESS_ZERO;

      await expect(subject()).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });
  });

  describe("#rescueNative", () => {
    let subjectCaller: Account;
    let subjectTo: string;
    let subjectAmount: BigNumber;

    beforeEach(async () => {
      await owner.wallet.sendTransaction({
        to: hook.address,
        value: ether(1)
      });

      subjectCaller = owner;
      subjectTo = recipient.address;
      subjectAmount = ether(1);
    });

    async function subject(): Promise<any> {
      return hook.connect(subjectCaller.wallet).rescueNative(subjectTo, subjectAmount);
    }

    it("should rescue native tokens to recipient", async () => {
      const recipientBalanceBefore = await ethers.provider.getBalance(recipient.address);

      await expect(subject())
        .to.emit(hook, "RescueNative")
        .withArgs(recipient.address, ether(1));

      const recipientBalanceAfter = await ethers.provider.getBalance(recipient.address);
      expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(ether(1));
    });

    it("should revert when called by non-owner", async () => {
      subjectCaller = attacker;

      await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert when recipient address is zero", async () => {
      subjectTo = ADDRESS_ZERO;

      await expect(subject()).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should allow partial rescue", async () => {
      subjectAmount = ether(0.5);

      await expect(subject())
        .to.emit(hook, "RescueNative")
        .withArgs(recipient.address, ether(0.5));

      const hookBalance = await ethers.provider.getBalance(hook.address);
      expect(hookBalance).to.eq(ether(0.5));
    });

    it("should revert when native transfer fails", async () => {
      const RejectEtherMock = await ethers.getContractFactory("RejectEtherMock", owner.wallet);
      const rejectContract = await RejectEtherMock.deploy();

      subjectTo = rejectContract.address;

      await expect(subject()).to.be.revertedWithCustomError(hook, "NativeTransferFailed");
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
