import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";
import { getWaffleExpect, getAccounts } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { DepositRateManagerRegistryV1, DepositRateManagerHookV1 } from "@typechain";

const expect = getWaffleExpect();

describe("DepositRateManagerHookV1", () => {
  // Accounts
  let owner: any, depositor: any, manager: any, feeRecipient: any;

  // Contracts
  let escrow: any;
  let registry: DepositRateManagerRegistryV1;
  let hook: DepositRateManagerHookV1;
  let usdcToken: any;
  let orchestrator: any;
  let verifier: any;

  let deployer: DeployHelper;

  // Common values
  let venmoPaymentMethod: BytesLike;
  let payeeDetailsHash: BytesLike;

  beforeEach(async () => {
    [owner, depositor, manager, feeRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const escrowRegistry = await deployer.deployEscrowRegistry();
    const paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    const postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    const relayerRegistry = await deployer.deployRelayerRegistry();

    escrow = await deployer.deployEscrow(owner.address, 1, paymentVerifierRegistry.address, ADDRESS_ZERO, ZERO, 10, 3600);
    await escrowRegistry.addEscrow(escrow.address);
    orchestrator = await deployer.deployOrchestrator(owner.address, 1, escrowRegistry.address, paymentVerifierRegistry.address, postIntentHookRegistry.address, relayerRegistry.address, 0, owner.address);
    await escrow.setOrchestrator(orchestrator.address);

    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);
    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(venmoPaymentMethod, verifier.address, [Currency.USD]);

    registry = (await (await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet)).deploy()) as DepositRateManagerRegistryV1;
    hook = (await (await ethers.getContractFactory("DepositRateManagerHookV1", owner.wallet)).deploy(registry.address)) as DepositRateManagerHookV1;

    // Common values
    payeeDetailsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("p"));
  });

  describe("#setMinLiquidity", () => {
    let subjectRateManagerId: BytesLike;
    let subjectMin: BigNumber;
    let subjectCaller: any;

    async function subject() {
      return hook.connect(subjectCaller.wallet).setMinLiquidity(subjectRateManagerId, subjectMin);
    }

    beforeEach(async () => {
      subjectCaller = manager;
      subjectMin = usdc(200);
      subjectRateManagerId = await createRateManagerAndGetId(registry, {
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: 0,
        depositHook: ADDRESS_ZERO,
        name: "n",
        uri: "u",
      });
    });

    it("updates threshold and emits", async () => {
      await expect(subject()).to.emit(hook, "MinLiquidityUpdated").withArgs(subjectRateManagerId, subjectMin);
      expect(await hook.minLiquidity(subjectRateManagerId)).to.eq(subjectMin);
    });

    describe("when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = depositor;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(hook, "NotManager");
      });
    });
  });

  describe("#onDepositOptIn", () => {
    let rateManagerId: BytesLike;

    beforeEach(async () => {
      // Seed deposit 100 USDC
      await usdcToken.transfer(depositor.address, usdc(1000));
      await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(1000));
      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(100),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [venmoPaymentMethod],
        paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payeeDetailsHash, data: "0x" }],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      rateManagerId = await createRateManagerAndGetId(registry, {
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: 0,
        depositHook: hook.address,
        name: "n",
        uri: "u",
      });
    });

    describe("when below manager min", () => {
      beforeEach(async () => {
        await hook.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(200));
      });
      it("should revert", async () => {
        await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, registry.address, rateManagerId)).to.be.revertedWithCustomError(hook, "BelowMinLiquidity");
      });
    });

    describe("when above manager min", () => {
      beforeEach(async () => {
        await hook.connect(manager.wallet).setMinLiquidity(rateManagerId, usdc(50));
      });
      it("emits deposit updated", async () => {
        await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, registry.address, rateManagerId)).to.emit(escrow, "DepositRateManagerUpdated");
      });
    });
  });
});

// Local helper to fetch id from createRateManager without double-wait
async function createRateManagerAndGetId(reg: DepositRateManagerRegistryV1, cfg: any): Promise<string> {
  const tx = await reg.createRateManager(cfg);
  const rcpt = await tx.wait();
  const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
  return ev?.args?.rateManagerId;
}

