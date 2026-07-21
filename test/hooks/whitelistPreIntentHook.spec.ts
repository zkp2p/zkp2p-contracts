import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import {
  EscrowV2,
  OrchestratorV2,
  OrchestratorRegistry,
  PaymentVerifierRegistry,
  EscrowRegistry,
  USDCMock,
  PaymentVerifierMock,
  WhitelistPreIntentHook,
  PreIntentHookMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("WhitelistPreIntentHook", () => {
  let owner: Account;
  let depositor: Account;
  let delegate: Account;
  let taker: Account;
  let takerTwo: Account;
  let unauthorizedCaller: Account;
  let feeRecipient: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let escrowRegistry: EscrowRegistry;
  let verifier: PaymentVerifierMock;
  let whitelistHook: WhitelistPreIntentHook;

  let chainId: BigNumber;
  let venmoPaymentMethod: BytesLike;
  let depositConversionRate: BigNumber;

  beforeEach(async () => {
    [owner, depositor, delegate, taker, takerTwo, unauthorizedCaller, feeRecipient] = await getAccounts();

    chainId = ONE;
    depositConversionRate = ether(1.01);
    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();

    escrow = await deployer.deployEscrowV2(
      owner.address,
      chainId,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
      BigNumber.from(60 * 60)
    );
    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      ZERO,
      feeRecipient.address
    );
    await orchestratorRegistry.addOrchestrator(orchestrator.address);

    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    await paymentVerifierRegistry.addPaymentMethod(
      venmoPaymentMethod,
      verifier.address,
      [Currency.USD]
    );

    whitelistHook = await deployer.deployWhitelistPreIntentHook(orchestratorRegistry.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [venmoPaymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: depositConversionRate, oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  describe("#constructor", () => {
    it("reverts when orchestratorRegistry is zero address", async () => {
      await expect(
        deployer.deployWhitelistPreIntentHook(ADDRESS_ZERO)
      ).to.be.revertedWithCustomError(whitelistHook, "ZeroAddress");
    });

    it("sets orchestratorRegistry correctly", async () => {
      expect(await whitelistHook.orchestratorRegistry()).to.eq(orchestratorRegistry.address);
    });
  });

  describe("#addToWhitelist", () => {
    let subjectCaller: Account;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectTakers: string[];

    async function subject(): Promise<any> {
      return whitelistHook.connect(subjectCaller.wallet).addToWhitelist(
        subjectEscrow,
        subjectDepositId,
        subjectTakers
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectTakers = [taker.address, takerTwo.address];
    });

    it("whitelists takers and emits per-taker events", async () => {
      const tx = subject();
      await expect(tx).to.emit(whitelistHook, "TakerWhitelisted")
        .withArgs(subjectEscrow, subjectDepositId, taker.address);
      await expect(tx).to.emit(whitelistHook, "TakerWhitelisted")
        .withArgs(subjectEscrow, subjectDepositId, takerTwo.address);

      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, taker.address)).to.be.true;
      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, takerTwo.address)).to.be.true;
      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, unauthorizedCaller.address)).to.be.false;
    });

    it("allows delegate to whitelist takers", async () => {
      subjectCaller = delegate;

      const tx = subject();
      await expect(tx).to.emit(whitelistHook, "TakerWhitelisted")
        .withArgs(subjectEscrow, subjectDepositId, taker.address);
      await expect(tx).to.emit(whitelistHook, "TakerWhitelisted")
        .withArgs(subjectEscrow, subjectDepositId, takerTwo.address);

      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, taker.address)).to.be.true;
    });

    describe("when called by unauthorized caller", () => {
      beforeEach(async () => {
        subjectCaller = unauthorizedCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "ZeroAddress");
      });
    });

    describe("when takers array is empty", () => {
      beforeEach(async () => {
        subjectTakers = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "EmptyArray");
      });
    });

    describe("when a taker is zero address", () => {
      beforeEach(async () => {
        subjectTakers = [taker.address, ADDRESS_ZERO];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "ZeroAddress");
      });
    });
  });

  describe("#removeFromWhitelist", () => {
    let subjectCaller: Account;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectTakers: string[];

    async function subject(): Promise<any> {
      return whitelistHook.connect(subjectCaller.wallet).removeFromWhitelist(
        subjectEscrow,
        subjectDepositId,
        subjectTakers
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectTakers = [taker.address];

      // Whitelist first
      await whitelistHook.connect(depositor.wallet).addToWhitelist(
        escrow.address,
        ZERO,
        [taker.address, takerTwo.address]
      );
    });

    it("removes takers from whitelist and emits per-taker event", async () => {
      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, taker.address)).to.be.true;

      await expect(subject()).to.emit(whitelistHook, "TakerRemovedFromWhitelist")
        .withArgs(subjectEscrow, subjectDepositId, taker.address);

      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, taker.address)).to.be.false;
      // takerTwo should still be whitelisted
      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, takerTwo.address)).to.be.true;
    });

    it("allows delegate to remove takers", async () => {
      subjectCaller = delegate;

      await expect(subject()).to.emit(whitelistHook, "TakerRemovedFromWhitelist")
        .withArgs(subjectEscrow, subjectDepositId, taker.address);

      expect(await whitelistHook.isWhitelisted(subjectEscrow, subjectDepositId, taker.address)).to.be.false;
    });

    describe("when called by unauthorized caller", () => {
      beforeEach(async () => {
        subjectCaller = unauthorizedCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "ZeroAddress");
      });
    });

    describe("when takers array is empty", () => {
      beforeEach(async () => {
        subjectTakers = [];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "EmptyArray");
      });
    });

    describe("when taker is not in whitelist", () => {
      beforeEach(async () => {
        subjectTakers = [unauthorizedCaller.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "TakerNotInWhitelist");
      });
    });
  });

  describe("#setDepositWhitelistHook", () => {
    let subjectCaller: Account;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectHook: string;

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setDepositWhitelistHook(
        subjectEscrow,
        subjectDepositId,
        subjectHook
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectHook = whitelistHook.address;
    });

    it("sets whitelist hook and emits event", async () => {
      await expect(subject()).to.emit(orchestrator, "DepositWhitelistHookSet")
        .withArgs(subjectEscrow, subjectDepositId, subjectHook, subjectCaller.address);

      const hook = await orchestrator.getDepositWhitelistHook(subjectEscrow, subjectDepositId);
      expect(hook).to.eq(whitelistHook.address);
    });

    it("allows delegate to set whitelist hook", async () => {
      subjectCaller = delegate;

      await expect(subject()).to.emit(orchestrator, "DepositWhitelistHookSet")
        .withArgs(subjectEscrow, subjectDepositId, subjectHook, delegate.address);
    });

    it("allows removing whitelist hook by setting to zero address", async () => {
      // Set hook first
      await subject();

      // Remove it
      subjectHook = ADDRESS_ZERO;
      await expect(subject()).to.emit(orchestrator, "DepositWhitelistHookSet")
        .withArgs(subjectEscrow, subjectDepositId, ADDRESS_ZERO, subjectCaller.address);

      const hook = await orchestrator.getDepositWhitelistHook(subjectEscrow, subjectDepositId);
      expect(hook).to.eq(ADDRESS_ZERO);
    });

    describe("when called by unauthorized caller", () => {
      beforeEach(async () => {
        subjectCaller = unauthorizedCaller;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });

    describe("when hook is an EOA (no code)", () => {
      beforeEach(async () => {
        subjectHook = taker.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "InvalidPreIntentHook");
      });
    });
  });

  describe("#validateSignalIntent via dedicated whitelist hook slot", () => {
    let subjectCaller: Account;
    let subjectConversionRate: BigNumber;

    async function subject(): Promise<any> {
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        subjectCaller.address,
        venmoPaymentMethod,
        Currency.USD,
        subjectConversionRate,
        ADDRESS_ZERO,
        ZERO,
        null,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );

      return orchestrator.connect(subjectCaller.wallet).signalIntent(params);
    }

    beforeEach(async () => {
      subjectCaller = taker;
      subjectConversionRate = ether(1.02);

      // Set whitelist hook on the DEDICATED whitelist slot (not the generic pre-intent hook slot)
      await orchestrator.connect(depositor.wallet).setDepositWhitelistHook(
        escrow.address,
        ZERO,
        whitelistHook.address
      );
    });

    describe("when taker is whitelisted", () => {
      beforeEach(async () => {
        await whitelistHook.connect(depositor.wallet).addToWhitelist(
          escrow.address,
          ZERO,
          [taker.address]
        );
      });

      it("allows signalIntent to succeed", async () => {
        await expect(subject()).to.emit(orchestrator, "IntentSignaled");

        const accountIntents = await orchestrator.getAccountIntents(taker.address);
        expect(accountIntents.length).to.eq(1);
      });
    });

    describe("when taker is not whitelisted", () => {
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "TakerNotWhitelisted");
      });
    });

    describe("when taker was whitelisted then removed", () => {
      beforeEach(async () => {
        await whitelistHook.connect(depositor.wallet).addToWhitelist(
          escrow.address,
          ZERO,
          [taker.address]
        );
        await whitelistHook.connect(depositor.wallet).removeFromWhitelist(
          escrow.address,
          ZERO,
          [taker.address]
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(whitelistHook, "TakerNotWhitelisted");
      });
    });

    describe("when called directly (not via orchestrator)", () => {
      it("should revert", async () => {
        const dummyCtx = {
          taker: taker.address,
          escrow: escrow.address,
          depositId: ZERO,
          amount: usdc(50),
          to: taker.address,
          paymentMethod: venmoPaymentMethod,
          fiatCurrency: Currency.USD,
          conversionRate: subjectConversionRate,
          referralFees: [],
          preIntentHookData: "0x",
        };

        await expect(
          whitelistHook.connect(taker.wallet).validateSignalIntent(dummyCtx)
        ).to.be.revertedWithCustomError(whitelistHook, "UnauthorizedOrchestratorCaller");
      });
    });
  });

  describe("both hooks set independently on same deposit", () => {
    let preIntentHookMock: PreIntentHookMock;
    let subjectConversionRate: BigNumber;

    beforeEach(async () => {
      subjectConversionRate = ether(1.02);

      preIntentHookMock = await deployer.deployPreIntentHookMock();

      // Set both hooks independently
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        preIntentHookMock.address
      );
      await orchestrator.connect(depositor.wallet).setDepositWhitelistHook(
        escrow.address,
        ZERO,
        whitelistHook.address
      );
    });

    it("both hooks are stored independently", async () => {
      const genericHook = await orchestrator.getDepositPreIntentHook(escrow.address, ZERO);
      const wlHook = await orchestrator.getDepositWhitelistHook(escrow.address, ZERO);

      expect(genericHook).to.eq(preIntentHookMock.address);
      expect(wlHook).to.eq(whitelistHook.address);
    });

    it("signalIntent calls both hooks - whitelisted taker passes", async () => {
      await whitelistHook.connect(depositor.wallet).addToWhitelist(
        escrow.address,
        ZERO,
        [taker.address]
      );

      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        venmoPaymentMethod,
        Currency.USD,
        subjectConversionRate,
        ADDRESS_ZERO,
        ZERO,
        null,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );

      await expect(
        orchestrator.connect(taker.wallet).signalIntent(params)
      ).to.emit(orchestrator, "IntentSignaled");
    });

    it("signalIntent reverts if whitelist hook rejects (taker not whitelisted)", async () => {
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        venmoPaymentMethod,
        Currency.USD,
        subjectConversionRate,
        ADDRESS_ZERO,
        ZERO,
        null,
        chainId.toString(),
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );

      await expect(
        orchestrator.connect(taker.wallet).signalIntent(params)
      ).to.be.revertedWithCustomError(whitelistHook, "TakerNotWhitelisted");
    });

    it("removing whitelist hook leaves generic hook intact", async () => {
      await orchestrator.connect(depositor.wallet).setDepositWhitelistHook(
        escrow.address,
        ZERO,
        ADDRESS_ZERO
      );

      const genericHook = await orchestrator.getDepositPreIntentHook(escrow.address, ZERO);
      const wlHook = await orchestrator.getDepositWhitelistHook(escrow.address, ZERO);

      expect(genericHook).to.eq(preIntentHookMock.address);
      expect(wlHook).to.eq(ADDRESS_ZERO);
    });

    it("removing generic hook leaves whitelist hook intact", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        ADDRESS_ZERO
      );

      const genericHook = await orchestrator.getDepositPreIntentHook(escrow.address, ZERO);
      const wlHook = await orchestrator.getDepositWhitelistHook(escrow.address, ZERO);

      expect(genericHook).to.eq(ADDRESS_ZERO);
      expect(wlHook).to.eq(whitelistHook.address);
    });
  });
});
