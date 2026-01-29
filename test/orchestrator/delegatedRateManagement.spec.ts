import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { Blockchain, ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { getAccounts, getWaffleExpect } from "@utils/test";

const expect = getWaffleExpect();
const blockchain = new Blockchain(ethers.provider);

describe("DelegatedRateManagement (MVP)", () => {
  let owner: Account;
  let depositor: Account;
  let taker: Account;
  let manager: Account;
  let managerFeeRecipient: Account;

  let deployer: DeployHelper;

  let usdcToken: any;
  let escrow: any;
  let orchestrator: any;
  let paymentVerifierRegistry: any;
  let escrowRegistry: any;
  let postIntentHookRegistry: any;
  let relayerRegistry: any;
  let verifier: any;

  let rateManagerRegistry: any;

  let chainId: BigNumber = ONE;
  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let rateManagerNonce: number;

  beforeEach(async () => {
    [owner, depositor, taker, manager, managerFeeRecipient] = await getAccounts();
    rateManagerNonce = 0;

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
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
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
      ZERO,
      owner.address
    );
    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    // Payment verifier + payment method
    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    // Deploy + wire the rate manager registry
    const registryFactory = await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet);
    rateManagerRegistry = await registryFactory.deploy();
    await escrow.connect(owner.wallet).setDepositRateManagerRegistry(rateManagerRegistry.address);

    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails"));
  });

  async function createDeposit(minRate: BigNumber): Promise<void> {
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
      currencies: [[{ code: Currency.USD, minConversionRate: minRate }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  }

  async function createRateManager(params?: {
    fee?: BigNumber;
    maxFee?: BigNumber;
    name?: string;
    uri?: string;
    hook?: string;
  }): Promise<BigNumber> {
    const tx = await rateManagerRegistry.createRateManager({
      manager: manager.address,
      feeRecipient: managerFeeRecipient.address,
      maxFee: params?.maxFee ?? ether(0.05),
      fee: params?.fee ?? ether(0.01),
      depositHook: params?.hook ?? ADDRESS_ZERO,
      name: params?.name ?? "USDCTOAIAT",
      uri: params?.uri ?? "ipfs://example",
    });
    const receipt = await tx.wait();
    const ev = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId;
  }

  async function signalIntent(conversionRate: BigNumber): Promise<string> {
    const tx = await orchestrator.connect(taker.wallet).signalIntent({
      escrow: escrow.address,
      depositId: ZERO,
      amount: usdc(50),
      to: taker.address,
      paymentMethod,
      fiatCurrency: Currency.USD,
      conversionRate,
      referrer: ADDRESS_ZERO,
      referrerFee: ZERO,
      gatingServiceSignature: "0x",
      signatureExpiration: ZERO,
      postIntentHook: ADDRESS_ZERO,
      data: "0x",
    });

    const receipt = await tx.wait();
    const intentSignaled = receipt.events?.find((e: any) => e.event === "IntentSignaled");
    return intentSignaled.args.intentHash;
  }

  describe("effective min rate", () => {
    it("enforces manager min rate when above depositor floor", async () => {
      await createDeposit(ether(1.0));

      const rateManagerId = await createRateManager({ fee: ZERO });
      await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.05));

      await escrow.connect(depositor.wallet).setDepositRateManager(ZERO, rateManagerId);

      await expect(signalIntent(ether(1.04))).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
      await expect(signalIntent(ether(1.05))).to.not.be.reverted;
    });

    it("never allows manager to undercut depositor floor", async () => {
      await createDeposit(ether(1.05));

      const rateManagerId = await createRateManager({ fee: ZERO });
      await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.02));

      await escrow.connect(depositor.wallet).setDepositRateManager(ZERO, rateManagerId);

      await expect(signalIntent(ether(1.03))).to.be.revertedWithCustomError(orchestrator, "RateBelowMinimum");
      await expect(signalIntent(ether(1.05))).to.not.be.reverted;
    });

    it("acts as a manager-level allowlist when manager rate is 0", async () => {
      await createDeposit(ether(1.0));

      const rateManagerId = await createRateManager({ fee: ZERO });
      await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ZERO);

      await escrow.connect(depositor.wallet).setDepositRateManager(ZERO, rateManagerId);

      await expect(signalIntent(ether(1.0))).to.be.revertedWithCustomError(orchestrator, "CurrencyNotSupported");
    });
  });

  describe("manager fee", () => {
    it("transfers manager fee on fulfillment", async () => {
      await createDeposit(ether(1.0));

      const rateManagerId = await createRateManager({ fee: ether(0.01) }); // 1%
      await rateManagerRegistry.connect(manager.wallet).setMinRate(rateManagerId, paymentMethod, Currency.USD, ether(1.0));
      await escrow.connect(depositor.wallet).setDepositRateManager(ZERO, rateManagerId);

      await verifier.setShouldVerifyPayment(true);

      const intentHash = await signalIntent(ether(1.0));

      const beforeTaker = await usdcToken.balanceOf(taker.address);
      const beforeManager = await usdcToken.balanceOf(managerFeeRecipient.address);

      const ts = await blockchain.getCurrentTimestamp();
      const proof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(50), ts, payeeDetails, Currency.USD, intentHash]
      );

      await orchestrator.connect(taker.wallet).fulfillIntent({
        paymentProof: proof,
        intentHash,
        verificationData: "0x",
        postIntentHookData: "0x",
      });

      const afterTaker = await usdcToken.balanceOf(taker.address);
      const afterManager = await usdcToken.balanceOf(managerFeeRecipient.address);

      const releaseAmount = usdc(50); // conversionRate 1.0
      const expectedManagerFee = releaseAmount.mul(ether(0.01)).div(ether(1));

      expect(afterManager.sub(beforeManager)).to.eq(expectedManagerFee);
      expect(afterTaker.sub(beforeTaker)).to.eq(releaseAmount.sub(expectedManagerFee));
    });
  });

  // min-delegation check moved to optional hook; no core revert expected in MVP
});
