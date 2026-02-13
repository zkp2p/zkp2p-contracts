import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { Blockchain, ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { getAccounts, getWaffleExpect } from "@utils/test";
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

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("DelegatedDepositsOnly (Global manager fee)", () => {
  let owner: Account;
  let depositor: Account;
  let taker: Account;
  let managerA: Account;
  let managerB: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let escrowRegistry: EscrowRegistry;
  let postIntentHookRegistry: PostIntentHookRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;

  const chainId: BigNumber = ONE;
  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  beforeEach(async () => {
    [owner, depositor, taker, managerA, managerB] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    postIntentHookRegistry = await deployer.deployPostIntentHookRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

    escrow = await deployer.deployEscrow(
      owner.address,
      chainId,
      paymentVerifierRegistry.address,
      ADDRESS_ZERO, // dustRecipient
      ZERO, // dustThreshold
      BigNumber.from(10), // maxIntentsPerDeposit
      BigNumber.from(60 * 60) // intentExpirationPeriod
    );
    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      postIntentHookRegistry.address,
      relayerRegistry.address,
      ZERO, // protocol fee
      owner.address // protocol fee recipient (unused)
    );
    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    // Payment verifier + payment method
    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));
  });

  async function createDeposit(params: { delegate: string }): Promise<void> {
    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1.0) }]],
      delegate: params.delegate,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  async function signalIntent(params: { conversionRate?: BigNumber; to?: string; amount?: BigNumber }): Promise<string> {
    const tx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: ZERO,
      amount: params.amount ?? usdc(50),
      to: params.to ?? taker.address,
      paymentMethod,
      fiatCurrency: Currency.USD,
      conversionRate: params.conversionRate ?? ether(1.0),
      referrer: ADDRESS_ZERO,
      referrerFee: ZERO,
      gatingServiceSignature: "0x",
      signatureExpiration: ZERO,
      postIntentHook: ADDRESS_ZERO,
      data: "0x",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "IntentSignaled");
    return ev?.args?.intentHash as string;
  }

  function buildProof(params: { intentHash: string; amount: BigNumber; timestamp: BigNumber }): string {
    // PaymentVerifierMock expects: (amount, timestamp, payeeDetails, fiatCurrency, intentHash)
    return ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [params.amount, params.timestamp, payeeDetails, Currency.USD, params.intentHash]
    );
  }

  describe("delegated-only gate", () => {
    it("reverts when deposit has no delegate", async () => {
      await createDeposit({ delegate: ADDRESS_ZERO });

      await expect(signalIntent({})).to.be.revertedWithCustomError(orchestrator, "DepositNotDelegated");
    });
  });

  describe("global manager fee", () => {
    beforeEach(async () => {
      await createDeposit({ delegate: managerA.address });
      await verifier.setShouldVerifyPayment(true);
      await orchestrator.connect(owner.wallet).setManagerFee(ether(0.01)); // 1%
    });

    it("transfers manager fee to deposit delegate on fulfillment", async () => {
      const intentHash = await signalIntent({});

      const ts = await blockchain.getCurrentTimestamp();
      const proof = buildProof({ intentHash, amount: usdc(50), timestamp: ts });

      const beforeTaker = await usdcToken.balanceOf(taker.address);
      const beforeMgr = await usdcToken.balanceOf(managerA.address);

      await orchestrator.connect(taker.wallet).fulfillIntent({
        paymentProof: proof,
        intentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });

      const afterTaker = await usdcToken.balanceOf(taker.address);
      const afterMgr = await usdcToken.balanceOf(managerA.address);

      const releaseAmount = usdc(50);
      const expectedManagerFee = releaseAmount.mul(ether(0.01)).div(ether(1));
      expect(afterMgr.sub(beforeMgr)).to.eq(expectedManagerFee);
      expect(afterTaker.sub(beforeTaker)).to.eq(releaseAmount.sub(expectedManagerFee));
    });

    it("snapshots manager fee at signal (changes after signal do not apply)", async () => {
      const intentHash = await signalIntent({});

      // Change global manager fee; fulfill should still use 1% snapshot.
      await orchestrator.connect(owner.wallet).setManagerFee(ether(0.02));

      const ts = await blockchain.getCurrentTimestamp();
      const proof = buildProof({ intentHash, amount: usdc(50), timestamp: ts });

      const beforeMgr = await usdcToken.balanceOf(managerA.address);
      await orchestrator.connect(taker.wallet).fulfillIntent({
        paymentProof: proof,
        intentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });
      const afterMgr = await usdcToken.balanceOf(managerA.address);

      const expectedManagerFee = usdc(50).mul(ether(0.01)).div(ether(1));
      expect(afterMgr.sub(beforeMgr)).to.eq(expectedManagerFee);
    });

    it("snapshots manager recipient at signal (delegate changes after signal do not redirect)", async () => {
      const intentHash = await signalIntent({});

      // Depositor updates the delegate after signal; fulfill should still pay the snapshotted managerA.
      await escrow.connect(depositor.wallet).setDelegate(ZERO, managerB.address);

      const ts = await blockchain.getCurrentTimestamp();
      const proof = buildProof({ intentHash, amount: usdc(50), timestamp: ts });

      const beforeA = await usdcToken.balanceOf(managerA.address);
      const beforeB = await usdcToken.balanceOf(managerB.address);

      await orchestrator.connect(taker.wallet).fulfillIntent({
        paymentProof: proof,
        intentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });

      const afterA = await usdcToken.balanceOf(managerA.address);
      const afterB = await usdcToken.balanceOf(managerB.address);

      const expectedManagerFee = usdc(50).mul(ether(0.01)).div(ether(1));
      expect(afterA.sub(beforeA)).to.eq(expectedManagerFee);
      expect(afterB.sub(beforeB)).to.eq(ZERO);
    });
  });
});
