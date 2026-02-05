import "module-alias/register";
import { ethers } from "hardhat";
import { getAccounts, getWaffleExpect } from "@utils/test";
import DeployHelper from "@utils/deploys";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { Blockchain, ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("Orchestrator — manager fee snapshot and ordering", () => {
  let owner: any, depositor: any, taker: any, manager: any, feeRecipient: any;
  let deployer: DeployHelper;
  let usdcToken: any, escrow: any, orchestrator: any, verifier: any, registry: any;

  beforeEach(async () => {
    [owner, depositor, taker, manager, feeRecipient] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

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

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [pm],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("p")), data: "0x" }],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    const id = (await (await registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: ether(0.01), depositHook: ADDRESS_ZERO, name: "n", uri: "u" })).wait()).events.find((e: any) => e.event === "RateManagerCreated").args.rateManagerId;
    await registry.connect(manager.wallet).setMinRate(id, pm, Currency.USD, ether(1));
    await escrow.connect(depositor.wallet).setDepositRateManager(0, registry.address, id);
  });

  it("emits fee event last and snapshots", async () => {
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const tx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: 0,
      amount: usdc(50),
      to: taker.address,
      paymentMethod: pm,
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
    const id = await escrow.getDepositRateManager(0);
    await registry.connect(manager.wallet).setFee(id, ether(0.02));

    await verifier.setShouldVerifyPayment(true);
    const ts = await blockchain.getCurrentTimestamp();
    const proof = ethers.utils.defaultAbiCoder.encode(["uint256", "uint256", "bytes32", "bytes32", "bytes32"], [usdc(50), ts, ethers.utils.keccak256(ethers.utils.toUtf8Bytes("p")), Currency.USD, intentHash]);
    const before = await (await ethers.getContractAt("IERC20", usdcToken.address)).balanceOf(feeRecipient.address);
    await orchestrator.connect(taker.wallet).fulfillIntent({ paymentProof: proof, intentHash, verificationData: "0x", postIntentHookData: "0x" });
    const after = await (await ethers.getContractAt("IERC20", usdcToken.address)).balanceOf(feeRecipient.address);
    const expected = usdc(50).mul(ether(0.01)).div(ether(1));
    expect(after.sub(before)).to.eq(expected);
  });
});
