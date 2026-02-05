import "module-alias/register";
import { ethers } from "hardhat";
import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { Blockchain, ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("Escrow — rate manager", () => {
  let owner: any, depositor: any, manager: any, feeRecipient: any, taker: any;
  let deployer: DeployHelper;
  let usdcToken: any, escrow: any, orchestrator: any;
  let escrowRegistry: any, paymentVerifierRegistry: any, postIntentHookRegistry: any, relayerRegistry: any;
  let registry: any, verifier: any, hook: any;

  beforeEach(async () => {
    [owner, depositor, manager, feeRecipient, taker] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(10_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

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

    const hf = await ethers.getContractFactory("RateManagerDepositHookMock", owner.wallet);
    hook = await hf.deploy();
  });

  async function createDeposit(minRate: any, pm: string, payee: string) {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [pm],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: payee, data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  it("setDepositRateManager calls deposit hook and emits", async () => {
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const payee = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    await createDeposit(ether(1), pm, payee);
    const tx = await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: hook.address, name: "n", uri: "u" });
    const ev = (await tx.wait()).events.find((e: any) => e.event === "RateManagerCreated");
    const id = ev.args.rateManagerId;

    await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, id)).to.emit(escrow, "DepositRateManagerUpdated");
    expect(await escrow.getDepositRateManager(0)).to.eq(id);
  });

  it("setDepositRateManager reverts on hook failure", async () => {
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const payee = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    await createDeposit(ether(1), pm, payee);
    const tx = await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: hook.address, name: "n", uri: "u" });
    const id = (await tx.wait()).events.find((e: any) => e.event === "RateManagerCreated").args.rateManagerId;
    await hook.setShouldRevert(true);
    await expect(escrow.connect(depositor.wallet).setDepositRateManager(0, id)).to.be.revertedWith("Hook: revert on opt-in");
  });

  it("getDepositCurrencyMinRate branches", async () => {
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const payee = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));
    await createDeposit(ether(1.0), pm, payee);
    const id = (await (await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: ADDRESS_ZERO, name: "n", uri: "u" })).wait()).events.find((e: any) => e.event === "RateManagerCreated").args.rateManagerId;

    // no manager → floor
    expect(await escrow.getDepositCurrencyMinRate(0, pm, Currency.USD)).to.eq(ether(1.0));
    // with manager disabled pair → 0
    await escrow.connect(depositor.wallet).setDepositRateManager(0, id);
    await registry.connect(manager.wallet).setMinRate(id, pm, Currency.USD, 0);
    expect(await escrow.getDepositCurrencyMinRate(0, pm, Currency.USD)).to.eq(0);
    // with manager>floor
    await registry.connect(manager.wallet).setMinRate(id, pm, Currency.USD, ether(1.1));
    expect(await escrow.getDepositCurrencyMinRate(0, pm, Currency.USD)).to.eq(ether(1.1));
    // with manager<floor → floor
    await registry.connect(manager.wallet).setMinRate(id, pm, Currency.USD, ether(0.9));
    expect(await escrow.getDepositCurrencyMinRate(0, pm, Currency.USD)).to.eq(ether(1.0));
  });
});

