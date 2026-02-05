import "module-alias/register";
import { ethers } from "hardhat";
import { getWaffleExpect, getAccounts } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

const expect = getWaffleExpect();

describe("DepositRateManagerHookV1", () => {
  let owner: any, depositor: any, manager: any, feeRecipient: any;
  let deployer: DeployHelper;
  let escrow: any, registry: any, hook: any, usdcToken: any, orchestrator: any, verifier: any;

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
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(pm, verifier.address, [Currency.USD]);

    const rf = await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet);
    registry = await rf.deploy();
    await escrow.setDepositRateManagerRegistry(registry.address);

    const hf = await ethers.getContractFactory("DepositRateManagerHookV1", owner.wallet);
    hook = await hf.deploy(registry.address);
  });

  it("setMinLiquidity updates per-id threshold", async () => {
    const id = (await (await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: ADDRESS_ZERO, name: "n", uri: "u" })).wait()).events.find((e: any) => e.event === "RateManagerCreated").args.rateManagerId;
    await expect(hook.connect(manager.wallet).setMinLiquidity(id, usdc(200))).to.emit(hook, "MinLiquidityUpdated").withArgs(id, usdc(200));
    expect(await hook.minLiquidity(id)).to.eq(usdc(200));
  });

  it("onDepositOptIn reverts when below min and allows otherwise", async () => {
    // Setup deposit with 100 USDC
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const payee = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("p"));
    await usdcToken.transfer(depositor.address, usdc(1000));
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(1000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [pm],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payee, data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    const id = (await (await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: hook.address, name: "n", uri: "u" })).wait()).events.find((e: any) => e.event === "RateManagerCreated").args.rateManagerId;
    await hook.connect(manager.wallet).setMinLiquidity(id, usdc(200));

    await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, id)).to.be.revertedWithCustomError(hook, "BelowMinLiquidity");

    // Lower min and try again
    await hook.connect(manager.wallet).setMinLiquidity(id, usdc(50));
    await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, id)).to.emit(escrow, "DepositRateManagerUpdated");
  });
});

