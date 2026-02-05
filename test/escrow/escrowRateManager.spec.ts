import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

import {
  Escrow,
  Orchestrator,
  PaymentVerifierRegistry,
  PostIntentHookRegistry,
  RelayerRegistry,
  EscrowRegistry,
  USDCMock,
  PaymentVerifierMock,
} from "@utils/contracts";

import { DepositRateManagerRegistryV1, RateManagerDepositHookMock, IDepositRateManagerRegistryV1 } from "@typechain";
import DeployHelper from "@utils/deploys";

const expect = getWaffleExpect();

describe("Escrow — rate manager", () => {
  // Accounts
  let owner: any, depositor: any, manager: any, managerFeeRecipient: any, taker: any;

  // Contracts
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let escrowRegistry: EscrowRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let usdcToken: USDCMock;
  let verifier: PaymentVerifierMock;
  let registry: DepositRateManagerRegistryV1;
  let hook: RateManagerDepositHookMock;

  // Common values
  let venmoPaymentMethod: BytesLike;
  let payeeDetailsHash: BytesLike;

  let deployer: DeployHelper;

  beforeEach(async () => {
    [owner, depositor, manager, managerFeeRecipient, taker] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(10_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

    escrow = await deployer.deployEscrow(owner.address, 1, paymentVerifierRegistry.address, ADDRESS_ZERO, ZERO, 10, 3600);
    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      1,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,
      0,
      owner.address
    );
    await escrow.setOrchestrator(orchestrator.address);

    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);
    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(venmoPaymentMethod, verifier.address, [Currency.USD]);

    payeeDetailsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    registry = await deployer.deployDepositRateManagerRegistryV1();
    hook = await deployer.deployRateManagerDepositHookMock();
  });

  // Local helper to avoid double-wait patterns when creating managers in tests
  async function createRateManagerAndGetId(
    reg: DepositRateManagerRegistryV1,
    cfg: IDepositRateManagerRegistryV1.RateManagerConfigStruct
  ): Promise<string> {
    const tx = await reg.createRateManager(cfg);
    const receipt = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }

  async function seedDeposit(minRate: BigNumber) {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [venmoPaymentMethod],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payeeDetailsHash, data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  describe("#setDepositRateManager", () => {
    let subjectDepositId: number;
    let subjectRegistry: string;
    let subjectRateManagerId: BytesLike;
    let subjectCaller: any;

    async function subject() {
      return escrow.connect(subjectCaller.wallet).setDepositRateManager(subjectDepositId, subjectRegistry, subjectRateManagerId);
    }

    beforeEach(async () => {
      await seedDeposit(ether(1));
      subjectDepositId = 0;
      subjectRegistry = registry.address;
      subjectCaller = depositor;
      subjectRateManagerId = await createRateManagerAndGetId(registry, {
        manager: manager.address,
        feeRecipient: managerFeeRecipient.address,
        maxFee: ether(0.05),
        fee: 0,
        depositHook: hook.address,
        name: "n",
        uri: "u",
      });
    });

    it("emits and stores rate manager id; hook is invoked", async () => {
      await expect(subject()).to.emit(escrow, "DepositRateManagerUpdated");
      const stored = await escrow.getDepositRateManager(subjectDepositId);
      expect(stored).to.eq(subjectRateManagerId);
    });

    describe("when hook fails", () => {
      beforeEach(async () => {
        await hook.setShouldRevert(true);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Hook: revert on opt-in");
      });
    });

    describe("when caller is not depositor", () => {
      beforeEach(async () => {
        subjectCaller = manager;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "UnauthorizedCaller");
      });
    });

    describe("when rateManagerId is zero", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroValue");
      });
    });

    describe("when registry is zero address", () => {
      beforeEach(async () => {
        subjectRegistry = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      });
    });

    describe("when rateManagerId not found in registry", () => {
      beforeEach(async () => {
        subjectRateManagerId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("does-not-exist"));
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(escrow, "RateManagerNotFound");
      });
    });
  });

  describe("#getDepositCurrencyMinRate", () => {
    let subjectDepositId: number;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrency: BytesLike;

    async function subject(): Promise<BigNumber> {
      return escrow.getDepositCurrencyMinRate(subjectDepositId, subjectPaymentMethod, subjectCurrency);
    }

    beforeEach(async () => {
      await seedDeposit(ether(1.0));
      subjectDepositId = 0;
      subjectPaymentMethod = venmoPaymentMethod;
      subjectCurrency = Currency.USD;
    });

    it("returns depositor floor when no manager", async () => {
      const result = await subject();
      expect(result).to.eq(ether(1.0));
    });

    describe("when manager disables pair", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await escrow.connect(depositor.wallet).setDepositRateManager(subjectDepositId, registry.address, rateManagerId);
        await registry.connect(manager.wallet).setMinRate(rateManagerId, subjectPaymentMethod, subjectCurrency, 0);
      });
      it("should return 0", async () => {
        expect(await subject()).to.eq(0);
      });
    });

    describe("when manager rate is above floor", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await escrow.connect(depositor.wallet).setDepositRateManager(subjectDepositId, registry.address, rateManagerId);
        await registry.connect(manager.wallet).setMinRate(rateManagerId, subjectPaymentMethod, subjectCurrency, ether(1.1));
      });
      it("should return the manager rate", async () => {
        expect(await subject()).to.eq(ether(1.1));
      });
    });

    describe("when manager rate is below floor", () => {
      let rateManagerId: string;
      beforeEach(async () => {
        rateManagerId = await createRateManagerAndGetId(registry, {
          manager: manager.address,
          feeRecipient: managerFeeRecipient.address,
          maxFee: ether(0.05),
          fee: 0,
          depositHook: ADDRESS_ZERO,
          name: "n",
          uri: "u",
        });
        await escrow.connect(depositor.wallet).setDepositRateManager(subjectDepositId, registry.address, rateManagerId);
        await registry.connect(manager.wallet).setMinRate(rateManagerId, subjectPaymentMethod, subjectCurrency, ether(0.9));
      });
      it("should return the depositor floor", async () => {
        expect(await subject()).to.eq(ether(1.0));
      });
    });
  });
});
