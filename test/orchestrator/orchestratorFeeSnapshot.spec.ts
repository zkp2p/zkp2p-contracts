import "module-alias/register";
import "module-alias/register";
import { ethers } from "hardhat";
import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { Blockchain, ether, usdc } from "@utils/common";
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
import { DepositRateManagerRegistryV1 } from "@typechain";

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("Orchestrator — manager fee snapshot and ordering", () => {
  // Accounts
  let owner: any, depositor: any, taker: any, manager: any, feeRecipient: any;
  let deployer: DeployHelper;
  // Contracts
  let usdcToken: USDCMock;
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let verifier: PaymentVerifierMock;
  let registry: DepositRateManagerRegistryV1;
  // Registries
  let escrowRegistry: EscrowRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;

  // Common values
  let venmoPaymentMethod: string;
  let payeeDetailsHash: string;

  beforeEach(async () => {
    [owner, depositor, taker, manager, feeRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
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
    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(venmoPaymentMethod, verifier.address, [Currency.USD]);

    registry = (await (await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet)).deploy()) as DepositRateManagerRegistryV1;

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [venmoPaymentMethod],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: (payeeDetailsHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("p"))), data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    const managerId = await createRateManagerAndGetId(registry, {
      manager: manager.address,
      feeRecipient: feeRecipient.address,
      maxFee: ether(0.05),
      fee: ether(0.01),
      depositHook: ADDRESS_ZERO,
      name: "n",
      uri: "u",
    });
    await registry.connect(manager.wallet).setMinRate(managerId, venmoPaymentMethod, Currency.USD, ether(1));
    await escrow.connect(depositor.wallet).setDepositRateManager(0, registry.address, managerId);
  });

  it("emits fee event last and snapshots", async () => {
    const tx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: 0,
      amount: usdc(50),
      to: taker.address,
      paymentMethod: venmoPaymentMethod,
      fiatCurrency: Currency.USD,
      conversionRate: ether(1),
      referrer: ADDRESS_ZERO,
      referrerFee: 0,
      gatingServiceSignature: "0x",
      signatureExpiration: 0,
      postIntentHook: ADDRESS_ZERO,
      data: "0x",
    });
    const rcpt = await tx.wait();
    const idxIntent = rcpt.events.findIndex((e: any) => e.event === "IntentSignaled");
    const idxFee = rcpt.events.findIndex((e: any) => e.event === "IntentManagerFeeUpdated");
    expect(idxFee).to.be.greaterThan(idxIntent);
    const intentHash = rcpt.events.find((e: any) => e.event === "IntentSignaled").args.intentHash;

    // Change manager fee after signal and assert snapshot is unchanged on fulfill
    const idAfter = await escrow.getDepositRateManager(0);
    await registry.connect(manager.wallet).setFee(idAfter, ether(0.02));

    await verifier.setShouldVerifyPayment(true);
    const ts = await blockchain.getCurrentTimestamp();
    const proof = ethers.utils.defaultAbiCoder.encode(["uint256", "uint256", "bytes32", "bytes32", "bytes32"], [usdc(50), ts, payeeDetailsHash, Currency.USD, intentHash]);
    const before = await (await ethers.getContractAt("IERC20", usdcToken.address)).balanceOf(feeRecipient.address);
    await orchestrator.connect(taker.wallet).fulfillIntent({ paymentProof: proof, intentHash, verificationData: "0x", postIntentHookData: "0x" });
    const after = await (await ethers.getContractAt("IERC20", usdcToken.address)).balanceOf(feeRecipient.address);
    const expected = usdc(50).mul(ether(0.01)).div(ether(1));
    expect(after.sub(before)).to.eq(expected);
  });
  // Local test helper to create a rate manager and return its id
  async function createRateManagerAndGetId(reg: DepositRateManagerRegistryV1, cfg: any): Promise<string> {
    const tx = await reg.createRateManager(cfg);
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }
});
