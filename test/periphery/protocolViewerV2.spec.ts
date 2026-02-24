import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, Contract } from "ethers";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import {
  EscrowRegistry,
  EscrowV2,
  OrchestratorRegistry,
  OrchestratorV2,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RelayerRegistry,
  USDCMock,
} from "@utils/contracts";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, ONE, ZERO, ONE_DAY_IN_SECONDS } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { createSignalIntentParams } from "@utils/test/helpers";

const expect = getWaffleExpect();

describe("ProtocolViewerV2", () => {
  let owner: Account;
  let depositor: Account;
  let taker: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;
  let protocolViewerV2: Contract;

  let paymentMethod: string;
  let payeeDetails: string;

  beforeEach(async () => {
    [owner, depositor, taker] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();

    verifier = await deployer.deployPaymentVerifierMock();

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    await paymentVerifierRegistry
      .connect(owner.wallet)
      .addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      ONE_DAY_IN_SECONDS
    );

    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      ONE,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      owner.address
    );

    await escrowRegistry.connect(owner.wallet).addEscrow(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestrator.address);
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails,
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1) }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    protocolViewerV2 = await (await ethers.getContractFactory("ProtocolViewerV2", owner.wallet)).deploy();
  });

  describe("#getDeposit", () => {
    it("returns deposit data for a provided escrow address", async () => {
      const depositView = await protocolViewerV2.getDeposit(escrow.address, ZERO);

      expect(depositView.depositId).to.eq(ZERO);
      expect(depositView.deposit.depositor).to.eq(depositor.address);
      expect(depositView.deposit.token).to.eq(usdcToken.address);
      expect(depositView.deposit.remainingDeposits).to.eq(usdc(500));
      expect(depositView.availableLiquidity).to.eq(usdc(500));
      expect(depositView.paymentMethods[0].paymentMethod).to.eq(paymentMethod);
      expect(depositView.paymentMethods[0].currencies[0].code).to.eq(Currency.USD);
    });

    it("reverts when escrow address is zero", async () => {
      await expect(protocolViewerV2.getDeposit(ADDRESS_ZERO, ZERO)).to.be.revertedWithCustomError(
        protocolViewerV2,
        "InvalidEscrow"
      );
    });
  });

  describe("#getDepositFromIds", () => {
    beforeEach(async () => {
      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(250),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1.01) }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });
    });

    it("returns all requested deposits", async () => {
      const deposits = await protocolViewerV2.getDepositFromIds(escrow.address, [ZERO, ONE]);

      expect(deposits.length).to.eq(2);
      expect(deposits[0].depositId).to.eq(ZERO);
      expect(deposits[1].depositId).to.eq(ONE);
      expect(deposits[1].deposit.remainingDeposits).to.eq(usdc(250));
    });

    it("reverts when escrow is zero even with empty deposit ids", async () => {
      await expect(protocolViewerV2.getDepositFromIds(ADDRESS_ZERO, [])).to.be.revertedWithCustomError(
        protocolViewerV2,
        "InvalidEscrow"
      );
    });
  });

  describe("#getAccountDeposits", () => {
    beforeEach(async () => {
      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(250),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1.01) }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });
    });

    it("returns deposits for an account from the provided escrow", async () => {
      const deposits = await protocolViewerV2.getAccountDeposits(escrow.address, depositor.address);

      expect(deposits.length).to.eq(2);
      expect(deposits[0].depositId).to.eq(ZERO);
      expect(deposits[1].depositId).to.eq(ONE);
      expect(deposits[1].deposit.remainingDeposits).to.eq(usdc(250));
    });
  });

  describe("#getIntent, #getIntents and #getAccountIntents", () => {
    let intentHash: string;

    beforeEach(async () => {
      await orchestrator.connect(owner.wallet).setAllowMultipleIntents(true);

      const paramsOne = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        paymentMethod,
        Currency.USD,
        ether(1),
        ADDRESS_ZERO,
        ZERO,
        null,
        "1",
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );

      const txOne = await orchestrator.connect(taker.wallet).signalIntent(paramsOne);
      const receiptOne = await txOne.wait();
      const signaledEvent = receiptOne.events?.find((event: any) => event.event === "IntentSignaled");
      intentHash = signaledEvent?.args?.intentHash;

      const paramsTwo = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(30),
        taker.address,
        paymentMethod,
        Currency.USD,
        ether(1),
        ADDRESS_ZERO,
        ZERO,
        null,
        "1",
        ADDRESS_ZERO,
        "0x",
        undefined,
        "0x"
      );
      await orchestrator.connect(taker.wallet).signalIntent(paramsTwo);
    });

    it("returns a single intent and resolves deposit using intent.escrow", async () => {
      const intentView = await protocolViewerV2.getIntent(orchestrator.address, intentHash);

      expect(intentView.intentHash).to.eq(intentHash);
      expect(intentView.intent.owner).to.eq(taker.address);
      expect(intentView.intent.escrow).to.eq(escrow.address);
      expect(intentView.deposit.depositId).to.eq(ZERO);
      expect(intentView.deposit.deposit.depositor).to.eq(depositor.address);
    });

    it("returns all intents for an account", async () => {
      const intents = await protocolViewerV2.getAccountIntents(orchestrator.address, taker.address);

      expect(intents.length).to.eq(2);
      expect(intents[0].intent.owner).to.eq(taker.address);
      expect(intents[1].intent.owner).to.eq(taker.address);
    });

    it("returns intents for a provided list of hashes", async () => {
      const intentHashes = await orchestrator.getAccountIntents(taker.address);
      const intents = await protocolViewerV2.getIntents(orchestrator.address, intentHashes);

      expect(intents.length).to.eq(2);
      expect(intents[0].intentHash).to.eq(intentHashes[0]);
      expect(intents[1].intentHash).to.eq(intentHashes[1]);
      expect(intents[0].intent.owner).to.eq(taker.address);
      expect(intents[1].intent.owner).to.eq(taker.address);
    });

    it("reverts when orchestrator address is zero", async () => {
      await expect(protocolViewerV2.getIntent(ADDRESS_ZERO, intentHash)).to.be.revertedWithCustomError(
        protocolViewerV2,
        "InvalidOrchestrator"
      );
    });
  });
});
