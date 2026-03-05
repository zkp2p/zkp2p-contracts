import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import {
  EscrowRegistry,
  EscrowV2,
  OrchestratorMock,
  OrchestratorRegistry,
  OrchestratorV2,
  PaymentVerifierMock,
  PaymentVerifierRegistry,
  RateManagerMock,
  RateManagerV1,
  RelayerRegistry,
  StaticOracleAdapterMock,
  RevertingOracleAdapterMock,
  USDCMock,
} from "@utils/contracts";

const expect = getWaffleExpect();

/**
 * Targeted tests to reach partial-coverage branches in
 *   - EscrowV2.sol
 *   - OrchestratorV2.sol
 *   - RateManagerV1.sol
 */
describe("Patch Coverage", () => {
  let owner: any;
  let depositor: any;
  let delegate: any;
  let taker: any;
  let other: any;
  let feeRecipient: any;
  let protocolFeeRecipient: any;
  let gatingService: any;
  let manager: any;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: EscrowV2;
  let orchestrator: OrchestratorV2;
  let escrowRegistry: EscrowRegistry;
  let orchestratorRegistry: OrchestratorRegistry;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let verifier: PaymentVerifierMock;
  let orchestratorMock: OrchestratorMock;
  let staticOracleAdapter: StaticOracleAdapterMock;
  let revertingOracleAdapter: RevertingOracleAdapterMock;
  let rateManagerMock: RateManagerMock;
  let rateManagerV1: RateManagerV1;

  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;
  let depositId: BigNumber;

  function buildOracleAdapterConfig(isValid: boolean, marketRate: BigNumber, updatedAt: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(
      ["bool", "uint256", "uint256"],
      [isValid, marketRate, updatedAt]
    );
  }

  beforeEach(async () => {
    [owner, depositor, delegate, taker, other, feeRecipient, protocolFeeRecipient, gatingService, manager] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000_000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(100_000));

    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();
    escrowRegistry = await deployer.deployEscrowRegistry();
    orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    staticOracleAdapter = (await (
      await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
    ).deploy()) as StaticOracleAdapterMock;
    revertingOracleAdapter = (await (
      await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
    ).deploy()) as RevertingOracleAdapterMock;

    verifier = await deployer.deployPaymentVerifierMock();
    rateManagerMock = await deployer.deployRateManagerMock();

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
      BigNumber.from(60 * 60)
    );

    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      ONE,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      protocolFeeRecipient.address
    );
    orchestratorMock = await deployer.deployOrchestratorMock(escrow.address);

    await escrowRegistry.connect(owner.wallet).addEscrow(escrow.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestrator.address);
    await orchestratorRegistry.connect(owner.wallet).addOrchestrator(orchestratorMock.address);
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(100_000));

    depositId = await escrow.depositCounter();
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
      currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });

    // Deploy RateManagerV1 for rate manager branch tests
    rateManagerV1 = await deployer.deployRateManagerV1(escrowRegistry.address);
  });

  /* ================================================================
   *  OrchestratorV2 -- escrow not whitelisted but acceptAllEscrows is true
   *  Covers: line 502: !escrowRegistry.isWhitelistedEscrow(...) && !escrowRegistry.isAcceptingAllEscrows()
   *  Tests the false-via-second-condition branch (acceptAllEscrows=true bypasses whitelist)
   * ================================================================ */
  describe("OrchestratorV2 -- acceptAllEscrows bypass", () => {
    it("allows signalIntent when escrow is not individually whitelisted but acceptAllEscrows is enabled", async () => {
      // Remove the escrow from whitelist
      await escrowRegistry.connect(owner.wallet).removeEscrow(escrow.address);

      // Enable the acceptAll flag
      await escrowRegistry.connect(owner.wallet).setAcceptAllEscrows(true);

      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        depositId,
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

      await expect(
        orchestrator.connect(taker.wallet).signalIntent(params)
      ).to.emit(orchestrator, "IntentSignaled");
    });
  });

  /* ================================================================
   *  EscrowV2 -- createDeposit with fee == 0 and feeRecipient zero
   *  Covers the false short-circuit in compound && conditions
   * ================================================================ */
  describe("EscrowV2 -- createDeposit with zero delegate (address(0))", () => {
    it("creates deposit with delegate set to address(0)", async () => {
      const newDepositId = await escrow.depositCounter();
      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(50),
        intentAmountRange: { min: usdc(10), max: usdc(50) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      const deposit = await escrow.getDeposit(newDepositId);
      expect(deposit.delegate).to.eq(ADDRESS_ZERO);
    });
  });

  /* ================================================================
   *  EscrowV2 -- _computeSpreadRate: isValidQuote = false (independent of marketRate)
   *  Covers: line 1423: !isValidQuote path separately from marketRate == 0
   * ================================================================ */
  describe("EscrowV2 -- _computeSpreadRate with invalid oracle quote", () => {
    it("returns fixed floor when oracle returns isValidQuote = false with non-zero marketRate", async () => {
      const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        depositId,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig: buildOracleAdapterConfig(false, ether(1.5), currentTimestamp),
          spreadBps: 200,
          maxStaleness: 3600,
        }
      );

      // Oracle halt: isValidQuote=false, spreadRate == 0, adapter configured → return 0
      const rate = await escrow.getDepositCurrencyMinRate(depositId, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });
  });

  /* ================================================================
   *  EscrowV2 -- _computeSpreadRate: rateUpdatedAt > block.timestamp (future)
   *  independent from rateUpdatedAt == 0
   *  Covers: line 1426: rateUpdatedAt > block.timestamp branch in the || condition
   * ================================================================ */
  describe("EscrowV2 -- _computeSpreadRate with future rateUpdatedAt", () => {
    it("returns fixed floor when oracle returns future rateUpdatedAt", async () => {
      const currentTimestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        depositId,
        paymentMethod,
        Currency.USD,
        {
          adapter: staticOracleAdapter.address,
          adapterConfig: buildOracleAdapterConfig(true, ether(1.5), currentTimestamp.add(1000)),
          spreadBps: 200,
          maxStaleness: 3600,
        }
      );

      // Oracle halt: rateUpdatedAt is in the future, spreadRate == 0, adapter configured → return 0
      const rate = await escrow.getDepositCurrencyMinRate(depositId, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });
  });

  /* ================================================================
   *  EscrowV2 -- _computeSpreadRate: oracle adapter reverts (catch path)
   *  Covers: line 1439 catch block
   * ================================================================ */
  describe("EscrowV2 -- _computeSpreadRate with reverting oracle adapter", () => {
    it("returns zero when oracle adapter reverts (oracle halt)", async () => {
      await escrow.connect(depositor.wallet).setOracleRateConfig(
        depositId,
        paymentMethod,
        Currency.USD,
        {
          adapter: revertingOracleAdapter.address,
          adapterConfig: "0x",
          spreadBps: 200,
          maxStaleness: 3600,
        }
      );

      const rate = await escrow.getDepositCurrencyMinRate(depositId, paymentMethod, Currency.USD);
      expect(rate).to.eq(ZERO);
    });
  });

  /* ================================================================
   *  EscrowV2 -- getEffectiveRate: delegated rate manager returns non-zero rate
   *  (exercises the true branch of config.rateManager != address(0) with success path)
   * ================================================================ */
  describe("EscrowV2 -- getEffectiveRate with delegated rate manager that succeeds", () => {
    let rateManagerId: BytesLike;

    beforeEach(async () => {
      rateManagerId = ethers.utils.formatBytes32String("manager-1");
      await rateManagerMock.connect(owner.wallet).setManager(rateManagerId, true);
      await rateManagerMock
        .connect(owner.wallet)
        .setRate(rateManagerId, escrow.address, depositId, paymentMethod, Currency.USD, ether(1.5));
      await escrow.connect(depositor.wallet).setRateManager(depositId, rateManagerMock.address, rateManagerId);
    });

    it("returns delegated rate", async () => {
      const rate = await escrow.getEffectiveRate(depositId, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.5));
    });
  });

  /* ================================================================
   *  EscrowV2 -- _closeDepositIfNecessary: retainOnEmpty true path
   *  Exercises the !_deposit.retainOnEmpty == false branch (doesn't close)
   * ================================================================ */
  describe("EscrowV2 -- withdrawDeposit with retainOnEmpty = true does not close", () => {
    let retainDepositId: BigNumber;

    beforeEach(async () => {
      retainDepositId = await escrow.depositCounter();
      await escrow.connect(depositor.wallet).createDeposit({
        token: usdcToken.address,
        amount: usdc(20),
        intentAmountRange: { min: usdc(10), max: usdc(200) },
        paymentMethods: [paymentMethod],
        paymentMethodData: [
          {
            intentGatingService: ADDRESS_ZERO,
            payeeDetails,
            data: "0x",
          },
        ],
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: true,
      });
    });

    it("keeps deposit open after full withdrawal when retainOnEmpty is true", async () => {
      await escrow.connect(depositor.wallet).withdrawDeposit(retainDepositId);

      const deposit = await escrow.getDeposit(retainDepositId);
      expect(deposit.depositor).to.not.eq(ADDRESS_ZERO); // Not deleted
      expect(deposit.remainingDeposits).to.eq(ZERO);
    });
  });

  /* ================================================================
   *  EscrowV2 -- _reclaimLiquidityIfNecessary:
   *  depositIntentHashes length == maxIntentsPerDeposit (second branch of ||)
   * ================================================================ */
  describe("EscrowV2 -- reclaim liquidity triggered by max intents", () => {
    it("reclaims expired intents when deposit is at max intent count", async () => {
      // Deploy escrow with maxIntentsPerDeposit = 1 to easily hit the limit
      const smallEscrow = await deployer.deployEscrowV2(
        owner.address,
        ONE,
        orchestratorRegistry.address,
        paymentVerifierRegistry.address,
        owner.address,
        ZERO,
        BigNumber.from(1),       // maxIntentsPerDeposit = 1
        BigNumber.from(60)       // 60 seconds intent expiry
      );

      await usdcToken.connect(depositor.wallet).approve(smallEscrow.address, usdc(100_000));

      const depId = await smallEscrow.depositCounter();
      await smallEscrow.connect(depositor.wallet).createDeposit({
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
        currencies: [[{ code: Currency.USD, minConversionRate: ether(1), oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG }]],
        delegate: ADDRESS_ZERO,
        intentGuardian: ADDRESS_ZERO,
        retainOnEmpty: false,
      });

      // Add orchestratorMock to orchestrator registry if not added
      const smallOrchestratorMock = await deployer.deployOrchestratorMock(smallEscrow.address);
      await orchestratorRegistry.connect(owner.wallet).addOrchestrator(smallOrchestratorMock.address);

      // Lock funds via orchestratorMock (1 intent at limit)
      await smallOrchestratorMock.lockFunds(depId, ethers.utils.formatBytes32String("intent-1"), usdc(20));

      // Fast forward past intent expiry
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);

      // Lock again — this triggers reclaim of expired intent because we're at max
      await expect(
        smallOrchestratorMock.lockFunds(depId, ethers.utils.formatBytes32String("intent-2"), usdc(20))
      ).to.not.be.reverted;
    });
  });

  /* ================================================================
   *  RateManagerV1 -- createRateManager with fee == 0 and feeRecipient == zero
   *  Covers: line 148: _config.fee > 0 short-circuit to false
   * ================================================================ */
  describe("RateManagerV1 -- createRateManager with zero fee and zero feeRecipient", () => {
    it("creates manager when fee is zero and feeRecipient is zero (skips fee-recipient check)", async () => {
      await expect(
        rateManagerV1.createRateManager({
          manager: manager.address,
          feeRecipient: ADDRESS_ZERO,
          maxFee: ether(0.05),
          fee: ZERO,
          minLiquidity: ZERO,
          name: "ZeroFee",
          uri: "ipfs://zero",
        })
      ).to.emit(rateManagerV1, "RateManagerCreated");
    });
  });

  /* ================================================================
   *  RateManagerV1 -- setFee with fee == 0 and feeRecipient == zero
   *  Covers: line 213: _fee > 0 short-circuit to false
   * ================================================================ */
  describe("RateManagerV1 -- setFee to zero with zero feeRecipient", () => {
    let rateManagerId: BytesLike;

    beforeEach(async () => {
      // Create a rate manager with fee and recipient
      const tx = await rateManagerV1.createRateManager({
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: ether(0.01),
        minLiquidity: ZERO,
        name: "RM",
        uri: "ipfs://rm",
      });
      const receipt = await tx.wait();
      const event = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
      rateManagerId = event?.args?.rateManagerId;

      // Set feeRecipient to zero via setRateManagerConfig (fee must be zero first)
      await rateManagerV1.connect(manager.wallet).setFee(rateManagerId, ZERO);
      await rateManagerV1.connect(manager.wallet).setRateManagerConfig(
        rateManagerId,
        manager.address,
        ADDRESS_ZERO,
        "RM",
        "ipfs://rm"
      );
    });

    it("allows setting fee to zero when feeRecipient is zero address", async () => {
      await expect(
        rateManagerV1.connect(manager.wallet).setFee(rateManagerId, ZERO)
      ).to.emit(rateManagerV1, "RateManagerFeeUpdated")
        .withArgs(rateManagerId, ZERO);
    });
  });

  /* ================================================================
   *  RateManagerV1 -- setRateManagerConfig when fee is zero and feeRecipient is zero
   *  Covers: line 194: config.fee > 0 short-circuit to false
   * ================================================================ */
  describe("RateManagerV1 -- setRateManagerConfig with zero fee allows zero feeRecipient", () => {
    let rateManagerId: BytesLike;

    beforeEach(async () => {
      const tx = await rateManagerV1.createRateManager({
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: ZERO,
        minLiquidity: ZERO,
        name: "RM",
        uri: "ipfs://rm",
      });
      const receipt = await tx.wait();
      const event = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
      rateManagerId = event?.args?.rateManagerId;
    });

    it("allows zero feeRecipient when fee is zero", async () => {
      await expect(
        rateManagerV1.connect(manager.wallet).setRateManagerConfig(
          rateManagerId,
          manager.address,
          ADDRESS_ZERO,
          "Updated",
          "ipfs://updated"
        )
      ).to.emit(rateManagerV1, "RateManagerConfigUpdated");
    });
  });

  /* ================================================================
   *  RateManagerV1 -- getRate: pure registry (no depositor floors)
   * ================================================================ */
  describe("RateManagerV1 -- getRate as pure registry", () => {
    let rateManagerId: BytesLike;

    beforeEach(async () => {
      const tx = await rateManagerV1.createRateManager({
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: ether(0.01),
        minLiquidity: ZERO,
        name: "RM",
        uri: "ipfs://rm",
      });
      const receipt = await tx.wait();
      const event = receipt.events?.find((e: any) => e.event === "RateManagerCreated");
      rateManagerId = event?.args?.rateManagerId;

      await rateManagerV1.connect(manager.wallet).setRate(
        rateManagerId,
        paymentMethod,
        Currency.USD,
        ether(1.1)
      );
    });

    it("returns manager rate directly without depositor state", async () => {
      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, Currency.USD);
      expect(rate).to.eq(ether(1.1));
    });

    it("returns zero when rate is not set for tuple", async () => {
      const otherCurrency = ethers.utils.formatBytes32String("EUR");
      const rate = await rateManagerV1.getRate(rateManagerId, escrow.address, ZERO, paymentMethod, otherCurrency);
      expect(rate).to.eq(ZERO);
    });
  });

  /* ================================================================
   *  OrchestratorV2 -- fulfillIntent: protocolFee > 0 && protocolFeeRecipient != address(0)
   *  and referrer != address(0) && referrerFee > 0
   *  Covers: lines 626, 632 compound conditions
   * ================================================================ */
  describe("OrchestratorV2 -- fulfillIntent with zero protocol fee", () => {
    it("fulfills intent correctly when protocol fee is zero (skips fee transfer)", async () => {
      // Protocol fee is already zero by default

      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        depositId,
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

      const signalTx = await orchestrator.connect(taker.wallet).signalIntent(params);
      const receipt = await signalTx.wait();
      const event = receipt.events?.find((e: any) => e.event === "IntentSignaled");
      const intentHash = event?.args?.intentHash;

      const timestamp = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp);
      const paymentProof = ethers.utils.defaultAbiCoder.encode(
        ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
        [usdc(50), timestamp, payeeDetails, Currency.USD, intentHash]
      );

      await expect(
        orchestrator.connect(owner.wallet).fulfillIntent({
          paymentProof,
          intentHash,
          verificationData: "0x",
          postIntentHookData: "0x",
        })
      ).to.emit(orchestrator, "IntentFulfilled");
    });
  });

  /* ================================================================
   *  EscrowV2 -- setAcceptingIntents: _acceptingIntents = false path
   *  Covers: line 622: _acceptingIntents && ... short-circuit to false
   * ================================================================ */
  describe("EscrowV2 -- setAcceptingIntents to false bypasses liquidity check", () => {
    it("allows disabling intents even when remaining deposits is below min range", async () => {
      // Withdraw most of the funds to bring remaining below min
      await escrow.connect(depositor.wallet).removeFunds(depositId, usdc(495));

      // Now remainingDeposits = 5 USDC, which is below min of 10 USDC
      // Setting acceptingIntents to false should still work (no liquidity check needed)
      await expect(
        escrow.connect(depositor.wallet).setAcceptingIntents(depositId, false)
      ).to.emit(escrow, "DepositAcceptingIntentsUpdated")
        .withArgs(depositId, false);
    });
  });

  /* ================================================================
   *  EscrowV2 -- _pruneIntentsOnOrchestrator: orchestratorAddress == address(0) skip
   *  Covers: line 1211: orchestratorAddress == address(0) continue branch
   * ================================================================ */
  describe("EscrowV2 -- prune with zeroed orchestrator mapping", () => {
    it("skips pruning when intent orchestrator mapping is cleared", async () => {
      // Create an intent via orchestratorMock
      await orchestratorMock.lockFunds(depositId, ethers.utils.formatBytes32String("prune-test"), usdc(20));

      // Clear the intentOrchestrator mapping via hardhat_setStorageAt
      // The intentOrchestrator mapping is at slot 15
      const intentHash = ethers.utils.formatBytes32String("prune-test");
      const mappingSlot = 15;
      const storageSlot = ethers.utils.solidityKeccak256(
        ["bytes32", "uint256"],
        [intentHash, mappingSlot]
      );
      await ethers.provider.send("hardhat_setStorageAt", [
        escrow.address,
        storageSlot,
        ethers.constants.HashZero,
      ]);

      // Fast forward past expiry
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Pruning should not revert even though orchestrator mapping is cleared
      await expect(
        escrow.connect(other.wallet).pruneExpiredIntents(depositId)
      ).to.not.be.reverted;
    });
  });

  /* ================================================================
   *  EscrowV2 -- _closeDepositIfNecessary: outstandingIntentAmount > 0 branch
   *  When there are outstanding intents, the deposit should NOT close even if remaining is 0
   * ================================================================ */
  describe("EscrowV2 -- withdrawDeposit with outstanding intents does not close", () => {
    it("does not close deposit when there are outstanding intents", async () => {
      // Lock funds via orchestratorMock
      await orchestratorMock.lockFunds(depositId, ethers.utils.formatBytes32String("active-intent"), usdc(50));

      // Withdraw deposit — should take remaining but not close due to outstanding intent
      await escrow.connect(depositor.wallet).withdrawDeposit(depositId);

      // Deposit should still exist (not deleted) because outstanding intent
      const deposit = await escrow.getDeposit(depositId);
      expect(deposit.depositor).to.eq(depositor.address);
      expect(deposit.outstandingIntentAmount).to.eq(usdc(50));
    });
  });

  /* ================================================================
   *  EscrowV2 -- _reclaimLiquidityIfNecessary: remainingDeposits >= _minRequiredAmount
   *  Tests the false branch of the || condition (no reclaim needed)
   * ================================================================ */
  describe("EscrowV2 -- removeFunds without needing to reclaim", () => {
    it("removes funds without reclaiming when sufficient liquidity exists", async () => {
      // removeFunds with small amount — no reclaim needed since plenty of liquidity
      await expect(
        escrow.connect(depositor.wallet).removeFunds(depositId, usdc(10))
      ).to.emit(escrow, "DepositWithdrawn")
        .withArgs(depositId, depositor.address, usdc(10));
    });
  });

  /* ================================================================
   *  RateManagerV1 -- constructor with zero address escrowRegistry
   *  Covers: BRDA line 125 branch 0 (true case of zero-address check)
   * ================================================================ */
  describe("RateManagerV1 -- constructor reverts with zero address", () => {
    it("reverts when escrowRegistry is zero address", async () => {
      const factory = await ethers.getContractFactory("RateManagerV1", owner.wallet);
      await expect(factory.deploy(ADDRESS_ZERO)).to.be.reverted;
    });
  });

  /* ================================================================
   *  RateManagerV1 -- onDepositOptIn with non-existent rate manager
   *  Covers: BRDA line 464 branch 0 (!isRateManager true path)
   * ================================================================ */
  describe("RateManagerV1 -- onDepositOptIn reverts for invalid rateManagerId", () => {
    it("reverts when rateManagerId does not exist", async () => {
      const nonExistentId = ethers.utils.formatBytes32String("nonexistent");
      // EscrowV2.setRateManager calls rateManagerV1.onDepositOptIn which checks isRateManager
      await expect(
        escrow.connect(depositor.wallet).setRateManager(depositId, rateManagerV1.address, nonExistentId)
      ).to.be.reverted;
    });
  });

  /* ================================================================
   *  EscrowV2 -- nonReentrant modifier on uncovered functions
   *  Covers: BRDA lines 234, 660, 690, 751, 789 branch 1
   *  Uses hardhat_setStorageAt to set ReentrancyGuard._status to
   *  _ENTERED (2) so the call hits the revert branch.
   * ================================================================ */
  describe("EscrowV2 -- nonReentrant modifier branches", () => {
    // ReentrancyGuard._status at slot 1 (Ownable._owner + Pausable._paused packed in slot 0)
    const REENTRANCY_SLOT = "0x01";
    const ENTERED = ethers.utils.hexZeroPad("0x02", 32);
    const NOT_ENTERED = ethers.utils.hexZeroPad("0x01", 32);

    afterEach(async () => {
      await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, NOT_ENTERED]);
    });

    describe("#withdrawDeposit when reentrancy guard is entered", () => {
      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(
          escrow.connect(depositor.wallet).withdrawDeposit(depositId)
        ).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });

    describe("#pruneExpiredIntents when reentrancy guard is entered", () => {
      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(
          escrow.connect(other.wallet).pruneExpiredIntents(depositId)
        ).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });

    describe("#lockFunds when reentrancy guard is entered", () => {
      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(
          orchestratorMock.lockFunds(depositId, ethers.utils.formatBytes32String("test"), usdc(10))
        ).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });

    describe("#unlockFunds when reentrancy guard is entered", () => {
      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(
          orchestratorMock.unlockFunds(depositId, ethers.utils.formatBytes32String("test"))
        ).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });

    describe("#unlockAndTransferFunds when reentrancy guard is entered", () => {
      beforeEach(async () => {
        await ethers.provider.send("hardhat_setStorageAt", [escrow.address, REENTRANCY_SLOT, ENTERED]);
      });

      it("reverts with ReentrancyGuard: reentrant call", async () => {
        await expect(
          orchestratorMock.unlockAndTransferFunds(
            depositId,
            ethers.utils.formatBytes32String("test"),
            usdc(10),
            taker.address
          )
        ).to.be.revertedWith("ReentrancyGuard: reentrant call");
      });
    });
  });

  /* ================================================================
   *  OrchestratorV2 -- nonReentrant on setDepositWhitelistHook
   *  Covers: BRDA line 222 branch 1
   * ================================================================ */
  describe("OrchestratorV2 -- nonReentrant on setDepositWhitelistHook", () => {
    const REENTRANCY_SLOT = "0x01";
    const ENTERED = ethers.utils.hexZeroPad("0x02", 32);
    const NOT_ENTERED = ethers.utils.hexZeroPad("0x01", 32);

    afterEach(async () => {
      await ethers.provider.send("hardhat_setStorageAt", [orchestrator.address, REENTRANCY_SLOT, NOT_ENTERED]);
    });

    it("reverts with ReentrancyGuard: reentrant call", async () => {
      await ethers.provider.send("hardhat_setStorageAt", [orchestrator.address, REENTRANCY_SLOT, ENTERED]);

      await expect(
        orchestrator.connect(depositor.wallet).setDepositWhitelistHook(escrow.address, depositId, ADDRESS_ZERO)
      ).to.be.revertedWith("ReentrancyGuard: reentrant call");
    });
  });
});
