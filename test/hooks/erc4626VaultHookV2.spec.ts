import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { ADDRESS_ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("ERC4626VaultHookV2", () => {
  let owner: Account;
  let orchestrator: Account;
  let recipient: Account;
  let sharesReceiver: Account;
  let attacker: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let vault: Contract;
  let orchestratorRegistry: Contract;
  let hook: Contract;

  const DEFAULT_MAX_SLIPPAGE_BPS = 500;

  // Encode VaultDepositCommitment struct for signalHookData
  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(address vault,address sharesReceiver,uint256 minSharesOut)"],
      [commitment]
    );
  };

  // Build HookExecutionContext for V2 execute
  const buildContext = (commitment: any, overrides: any = {}): any => {
    const intentHash = overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32));
    return {
      intentHash,
      token: overrides.token ?? usdcToken.address,
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
    [owner, orchestrator, recipient, sharesReceiver, attacker] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const ERC4626VaultMock = await ethers.getContractFactory("ERC4626VaultMock", owner.wallet);
    vault = await ERC4626VaultMock.deploy(usdcToken.address, 6, "Vault USDC", "vUSDC");

    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    await orchestratorRegistry.addOrchestrator(orchestrator.address);

    const ERC4626VaultHookV2 = await ethers.getContractFactory("ERC4626VaultHookV2", owner.wallet);
    hook = await ERC4626VaultHookV2.deploy(
      usdcToken.address,
      orchestratorRegistry.address,
      DEFAULT_MAX_SLIPPAGE_BPS
    );

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  describe("#constructor", () => {
    it("should set initial variables correctly", async () => {
      expect(await hook.inputToken()).to.eq(usdcToken.address);
      expect(await hook.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
      expect(await hook.maxSlippageBps()).to.eq(DEFAULT_MAX_SLIPPAGE_BPS);
    });

    it("should set owner to deployer", async () => {
      expect(await hook.owner()).to.eq(owner.address);
    });

    it("should revert when inputToken is zero address", async () => {
      const ERC4626VaultHookV2 = await ethers.getContractFactory("ERC4626VaultHookV2", owner.wallet);
      await expect(
        ERC4626VaultHookV2.deploy(ADDRESS_ZERO, orchestratorRegistry.address, DEFAULT_MAX_SLIPPAGE_BPS)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when orchestratorRegistry is zero address", async () => {
      const ERC4626VaultHookV2 = await ethers.getContractFactory("ERC4626VaultHookV2", owner.wallet);
      await expect(
        ERC4626VaultHookV2.deploy(usdcToken.address, ADDRESS_ZERO, DEFAULT_MAX_SLIPPAGE_BPS)
      ).to.be.revertedWithCustomError(hook, "ZeroAddress");
    });

    it("should revert when maxSlippageBps exceeds 10000", async () => {
      const ERC4626VaultHookV2 = await ethers.getContractFactory("ERC4626VaultHookV2", owner.wallet);
      await expect(
        ERC4626VaultHookV2.deploy(usdcToken.address, orchestratorRegistry.address, 10_001)
      ).to.be.revertedWithCustomError(hook, "InvalidMaxSlippageBps");
    });

    it("should accept maxSlippageBps equal to 10000", async () => {
      const ERC4626VaultHookV2 = await ethers.getContractFactory("ERC4626VaultHookV2", owner.wallet);
      const h = await ERC4626VaultHookV2.deploy(usdcToken.address, orchestratorRegistry.address, 10_000);
      expect(await h.maxSlippageBps()).to.eq(10_000);
    });
  });

  describe("#execute", () => {
    let subjectCaller: Account;
    let subjectCtx: any;
    let subjectFulfillHookData: string;

    let commitment: any;

    beforeEach(async () => {
      commitment = {
        vault: vault.address,
        sharesReceiver: sharesReceiver.address,
        minSharesOut: usdc(50)
      };

      subjectCtx = buildContext(commitment);
      subjectFulfillHookData = "0x";
      subjectCaller = orchestrator;

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, subjectCtx.executableAmount);
    });

    async function subject(): Promise<any> {
      return hook.connect(subjectCaller.wallet).execute(subjectCtx, subjectFulfillHookData);
    }

    it("should deposit successfully with valid parameters", async () => {
      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject())
        .to.emit(hook, "VaultDepositExecuted")
        .withArgs(
          subjectCtx.intentHash,
          vault.address,
          sharesReceiver.address,
          subjectCtx.executableAmount,
          subjectCtx.executableAmount
        );

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const vaultBalance = await usdcToken.balanceOf(vault.address);
      const receiverShares = await vault.balanceOf(sharesReceiver.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(subjectCtx.executableAmount);
      expect(hookBalance).to.eq(0);
      expect(vaultBalance).to.eq(subjectCtx.executableAmount);
      expect(receiverShares).to.eq(subjectCtx.executableAmount);
    });

    it("should leave zero residual allowance to the vault on success", async () => {
      await subject();
      expect(await usdcToken.allowance(hook.address, vault.address)).to.eq(0);
    });

    it("should revert when caller is not a registered orchestrator", async () => {
      subjectCaller = attacker;
      await expect(subject()).to.be.revertedWithCustomError(hook, "UnauthorizedOrchestratorCaller");
    });

    it("should revert when fulfillHookData is non-empty", async () => {
      subjectFulfillHookData = ethers.utils.defaultAbiCoder.encode(["uint256"], [1]);
      await expect(subject()).to.be.revertedWithCustomError(hook, "InvalidFulfillHookDataLength");
    });

    it("should revert when ctx.token does not match inputToken", async () => {
      const otherToken = await deployer.deployUSDCMock(usdc(1000), "OTHER", "OTHER");
      subjectCtx = buildContext(commitment, { token: otherToken.address });
      await usdcToken.connect(orchestrator.wallet).approve(hook.address, subjectCtx.executableAmount);
      await expect(subject()).to.be.revertedWithCustomError(hook, "UnsupportedToken");
    });

    it("should revert when commitment vault is zero address", async () => {
      commitment.vault = ADDRESS_ZERO;
      subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });
      await expect(subject()).to.be.revertedWithCustomError(hook, "InvalidVault");
    });

    it("should revert when commitment sharesReceiver is zero address", async () => {
      commitment.sharesReceiver = ADDRESS_ZERO;
      subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });
      await expect(subject()).to.be.revertedWithCustomError(hook, "InvalidSharesReceiver");
    });

    describe("when previewDeposit returns fewer shares than minSharesOut", () => {
      beforeEach(async () => {
        // Set 1:1 vault to mint 1 share per 2 assets -> preview = executableAmount / 2 = usdc(25) < usdc(50)
        await vault.setSharesPerAsset(1, 2);
      });

      it("should fall back to direct transfer with PREVIEW_BELOW_MINIMUM reason", async () => {
        const recipientBalanceBefore = await usdcToken.balanceOf(recipient.address);

        // FallbackReason.PREVIEW_BELOW_MINIMUM = 0
        await expect(subject())
          .to.emit(hook, "FallbackTransfer")
          .withArgs(subjectCtx.intentHash, recipient.address, subjectCtx.executableAmount, 0);

        const recipientBalanceAfter = await usdcToken.balanceOf(recipient.address);
        const hookBalance = await usdcToken.balanceOf(hook.address);
        const vaultBalance = await usdcToken.balanceOf(vault.address);
        const receiverShares = await vault.balanceOf(sharesReceiver.address);

        expect(recipientBalanceAfter.sub(recipientBalanceBefore)).to.eq(subjectCtx.executableAmount);
        expect(hookBalance).to.eq(0);
        expect(vaultBalance).to.eq(0);
        expect(receiverShares).to.eq(0);
      });
    });

    describe("when previewDeposit reverts", () => {
      beforeEach(async () => {
        await vault.setPreviewShouldRevert(true);
      });

      it("should fall back to direct transfer with DEPOSIT_CALL_FAILED reason", async () => {
        // FallbackReason.DEPOSIT_CALL_FAILED = 1
        await expect(subject())
          .to.emit(hook, "FallbackTransfer")
          .withArgs(subjectCtx.intentHash, recipient.address, subjectCtx.executableAmount, 1);

        const recipientBalance = await usdcToken.balanceOf(recipient.address);
        expect(recipientBalance).to.eq(subjectCtx.executableAmount);
      });
    });

    describe("when vault.deposit reverts", () => {
      beforeEach(async () => {
        await vault.setDepositShouldRevert(true);
      });

      it("should fall back to direct transfer with DEPOSIT_CALL_FAILED reason", async () => {
        // FallbackReason.DEPOSIT_CALL_FAILED = 1
        await expect(subject())
          .to.emit(hook, "FallbackTransfer")
          .withArgs(subjectCtx.intentHash, recipient.address, subjectCtx.executableAmount, 1);

        const recipientBalance = await usdcToken.balanceOf(recipient.address);
        const hookBalance = await usdcToken.balanceOf(hook.address);
        expect(recipientBalance).to.eq(subjectCtx.executableAmount);
        expect(hookBalance).to.eq(0);
        // Allowance should be cleared in the catch arm
        expect(await usdcToken.allowance(hook.address, vault.address)).to.eq(0);
      });
    });

    describe("when actual minted shares are below the maker minimum", () => {
      beforeEach(async () => {
        // Preview will return executableAmount, passing the gate. But the deposit forces a tiny share count.
        await vault.setForcedActualShares(1);
      });

      it("should hard revert with VaultActualBelowMinimum", async () => {
        await expect(subject()).to.be.revertedWithCustomError(hook, "VaultActualBelowMinimum");
      });
    });

    describe("when actual minted shares are below the deploy-time guardrail", () => {
      beforeEach(async () => {
        // Maker is permissive (minSharesOut = 0), but the deploy guardrail (5%) still applies.
        commitment.minSharesOut = BigNumber.from(0);
        subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });
        // Preview = executableAmount = usdc(50). Guardrail floor = 50 * 9500/10000 = usdc(47.5).
        // Force actual to be just below guardrail.
        await vault.setForcedActualShares(usdc(47));
      });

      it("should hard revert with VaultActualBelowMinimum", async () => {
        await expect(subject()).to.be.revertedWithCustomError(hook, "VaultActualBelowMinimum");
      });
    });

    describe("when actual minted shares are exactly at the guardrail floor", () => {
      beforeEach(async () => {
        commitment.minSharesOut = BigNumber.from(0);
        subjectCtx = buildContext(commitment, { intentHash: subjectCtx.intentHash });
        // Preview = usdc(50). Guardrail floor = usdc(47.5).
        await vault.setForcedActualShares(usdc(47.5));
      });

      it("should succeed", async () => {
        await expect(subject()).to.emit(hook, "VaultDepositExecuted");
        expect(await vault.balanceOf(sharesReceiver.address)).to.eq(usdc(47.5));
      });
    });

    describe("when the vault mints shares without pulling the underlying", () => {
      beforeEach(async () => {
        // Non-compliant vault: mints shares but never calls transferFrom on the hook.
        await vault.setSkipAssetPull(true);
      });

      it("should hard revert with VaultDidNotConsumeAssets", async () => {
        await expect(subject()).to.be.revertedWithCustomError(hook, "VaultDidNotConsumeAssets");
      });
    });

    describe("when actual minted shares exceed minSharesOut and the guardrail", () => {
      beforeEach(async () => {
        // Vault gives a bonus: 11/10 ratio. Preview = 55, actual = 55, minSharesOut = 50.
        await vault.setSharesPerAsset(11, 10);
      });

      it("should succeed and credit the full share amount", async () => {
        await subject();
        expect(await vault.balanceOf(sharesReceiver.address)).to.eq(usdc(55));
      });
    });

    it("should support a sharesReceiver different from intent.to", async () => {
      // sharesReceiver is already a separate address by default; verify intent.to gets nothing
      // and sharesReceiver gets the shares.
      const intentToBefore = await usdcToken.balanceOf(recipient.address);
      const intentToVaultSharesBefore = await vault.balanceOf(recipient.address);

      await subject();

      const intentToAfter = await usdcToken.balanceOf(recipient.address);
      const intentToVaultSharesAfter = await vault.balanceOf(recipient.address);
      const sharesReceiverShares = await vault.balanceOf(sharesReceiver.address);

      expect(intentToAfter).to.eq(intentToBefore);
      expect(intentToVaultSharesAfter).to.eq(intentToVaultSharesBefore);
      expect(sharesReceiverShares).to.eq(subjectCtx.executableAmount);
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
      await expect(subject())
        .to.emit(hook, "RescueERC20")
        .withArgs(stuckToken.address, recipient.address, usdc(100));

      expect(await stuckToken.balanceOf(recipient.address)).to.eq(usdc(100));
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
});
