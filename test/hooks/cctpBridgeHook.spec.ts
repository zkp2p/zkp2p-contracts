import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { ADDRESS_ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("CctpBridgeHook", () => {
  let owner: Account;
  let orchestrator: Account;
  let recipient: Account;
  let attacker: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let tokenMessenger: Contract;
  let hook: Contract;

  const sourceDomain = 6;
  const defaultMaxFeeBps = 10;

  beforeEach(async () => {
    [owner, orchestrator, recipient, attacker] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const TokenMessengerV2Mock = await ethers.getContractFactory("TokenMessengerV2Mock", owner.wallet);
    tokenMessenger = await TokenMessengerV2Mock.deploy();

    const CctpBridgeHook = await ethers.getContractFactory("CctpBridgeHook", owner.wallet);
    hook = await CctpBridgeHook.deploy(usdcToken.address, orchestrator.address, tokenMessenger.address, sourceDomain);

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      [
        "tuple(uint32 destinationDomain,bytes32 mintRecipient,bytes32 destinationCaller,uint32 minFinalityThreshold)"
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
      intentHash: overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32))
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 intentHash)"],
      [data]
    );

    return { encoded, data };
  };

  describe("#execute", () => {
    let commitment: any;
    let commitmentData: string;
    let intent: any;
    let amountNetFees: BigNumber;
    let expectedMaxFee: BigNumber;

    beforeEach(async () => {
      commitment = {
        destinationDomain: 7,
        mintRecipient: ethers.utils.hexZeroPad(recipient.address.toLowerCase(), 32),
        destinationCaller: ethers.utils.hexZeroPad(ADDRESS_ZERO, 32),
        minFinalityThreshold: 1000
      };

      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      amountNetFees = usdc(50);
      expectedMaxFee = amountNetFees.mul(defaultMaxFeeBps).div(10_000);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);
    });

    async function subject(encodedFulfillData: string): Promise<any> {
      return hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encodedFulfillData);
    }

    it("should execute with valid data", async () => {
      const { encoded, data } = buildFulfillData();

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject(encoded)).to.emit(hook, "CctpBridgeInitiated").withArgs(
        data.intentHash,
        commitment.destinationDomain,
        commitment.mintRecipient,
        amountNetFees,
        expectedMaxFee,
        commitment.minFinalityThreshold
      );

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const messengerBalance = await usdcToken.balanceOf(tokenMessenger.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(amountNetFees);
      expect(hookBalance).to.eq(0);
      expect(messengerBalance).to.eq(amountNetFees);

      const lastDeposit = await tokenMessenger.lastDeposit();
      expect(lastDeposit.destinationDomain).to.eq(commitment.destinationDomain);
      expect(lastDeposit.mintRecipient).to.eq(commitment.mintRecipient);
      expect(lastDeposit.burnToken).to.eq(usdcToken.address);
      expect(lastDeposit.destinationCaller).to.eq(commitment.destinationCaller);
      expect(lastDeposit.maxFee).to.eq(expectedMaxFee);
      expect(lastDeposit.minFinalityThreshold).to.eq(commitment.minFinalityThreshold);
    });

    it("should revert when caller is not orchestrator", async () => {
      const { encoded } = buildFulfillData();

      await expect(
        hook.connect(attacker.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should revert when destinationDomain is zero", async () => {
      commitment.destinationDomain = 0;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidDestinationDomain");
    });

    it("should revert when destinationDomain equals sourceDomain", async () => {
      commitment.destinationDomain = sourceDomain;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidDestinationDomain");
    });

    it("should revert when mintRecipient is zero", async () => {
      commitment.mintRecipient = ethers.utils.hexZeroPad(ADDRESS_ZERO, 32);
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidRecipient");
    });

    it("should revert when minFinalityThreshold is invalid", async () => {
      commitment.minFinalityThreshold = 1500;
      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      const { encoded } = buildFulfillData();

      await expect(subject(encoded)).to.be.revertedWithCustomError(hook, "InvalidFinalityThreshold");
    });

    it("should use updated maxFeeBps", async () => {
      const { encoded, data } = buildFulfillData();
      const newMaxFeeBps = 25;
      const updatedMaxFee = amountNetFees.mul(newMaxFeeBps).div(10_000);

      await hook.connect(owner.wallet).setMaxFeeBps(newMaxFeeBps);

      await expect(subject(encoded)).to.emit(hook, "CctpBridgeInitiated").withArgs(
        data.intentHash,
        commitment.destinationDomain,
        commitment.mintRecipient,
        amountNetFees,
        updatedMaxFee,
        commitment.minFinalityThreshold
      );
    });

  });

  describe("#constructor", () => {
    it("should set immutable variables correctly", async () => {
      expect(await hook.inputToken()).to.eq(usdcToken.address);
      expect(await hook.orchestrator()).to.eq(orchestrator.address);
      expect(await hook.tokenMessenger()).to.eq(tokenMessenger.address);
      expect(await hook.sourceDomain()).to.eq(sourceDomain);
      expect(await hook.maxFeeBps()).to.eq(defaultMaxFeeBps);
    });

    it("should revert when inputToken is zero address", async () => {
      const CctpBridgeHook = await ethers.getContractFactory("CctpBridgeHook", owner.wallet);
      await expect(
        CctpBridgeHook.deploy(ADDRESS_ZERO, orchestrator.address, tokenMessenger.address, sourceDomain)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when orchestrator is zero address", async () => {
      const CctpBridgeHook = await ethers.getContractFactory("CctpBridgeHook", owner.wallet);
      await expect(
        CctpBridgeHook.deploy(usdcToken.address, ADDRESS_ZERO, tokenMessenger.address, sourceDomain)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when tokenMessenger is zero address", async () => {
      const CctpBridgeHook = await ethers.getContractFactory("CctpBridgeHook", owner.wallet);
      await expect(
        CctpBridgeHook.deploy(usdcToken.address, orchestrator.address, ADDRESS_ZERO, sourceDomain)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when sourceDomain is zero", async () => {
      const CctpBridgeHook = await ethers.getContractFactory("CctpBridgeHook", owner.wallet);
      await expect(
        CctpBridgeHook.deploy(usdcToken.address, orchestrator.address, tokenMessenger.address, 0)
      ).to.be.revertedWithCustomError(hook, "InvalidDestinationDomain");
    });

    it("should set owner to deployer", async () => {
      expect(await hook.owner()).to.eq(owner.address);
    });
  });

  describe("#setMaxFeeBps", () => {
    it("should update maxFeeBps when called by owner", async () => {
      await expect(hook.connect(owner.wallet).setMaxFeeBps(50))
        .to.emit(hook, "MaxFeeBpsUpdated")
        .withArgs(defaultMaxFeeBps, 50);

      expect(await hook.maxFeeBps()).to.eq(50);
    });

    it("should revert when maxFeeBps is too high", async () => {
      await expect(
        hook.connect(owner.wallet).setMaxFeeBps(10_000)
      ).to.be.revertedWithCustomError(hook, "InvalidMaxFeeBps");
    });

    it("should revert when caller is not owner", async () => {
      await expect(
        hook.connect(attacker.wallet).setMaxFeeBps(25)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });
});
