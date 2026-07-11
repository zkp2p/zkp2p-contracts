import "module-alias/register";

import { expect } from "chai";
import { BigNumber, BytesLike, Contract } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { ADDRESS_ZERO, EMPTY_ORACLE_RATE_CONFIG, ONE, ZERO } from "@utils/constants";
import { Currency } from "@utils/protocolUtils";
import { getAccounts } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";

describe("Open orchestrator real risk lifecycle", () => {
  let owner: any;
  let maker: any;
  let taker: any;
  let identityAttestor: any;
  let caller: any;
  let token: any;
  let escrow: any;
  let orchestrator: any;
  let verifier: any;
  let identityRegistry: Contract;
  let reputationRegistry: Contract;
  let stakeVault: Contract;
  let riskManager: Contract;
  let paymentMethod: BytesLike;
  let payeeDetails: BytesLike;

  const intentExpiration = 60 * 60;

  async function registerTakerIdentity(): Promise<void> {
    const issuedAtMs = (await time.latest()) * 1_000;
    const actionType = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("register_venmo"));
    const payeeIdHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("integration-taker"));
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("integration-identity"));
    const attestation = {
      method: paymentMethod,
      actionType,
      account: taker.address,
      payeeIdHash,
      dataHash,
      issuedAtMs,
      validUntilMs: issuedAtMs + 30 * 24 * 60 * 60 * 1_000,
    };
    const signature = await identityAttestor.wallet._signTypedData(
      { name: "ZKP2PIdentityVerifier", version: "1" },
      {
        IdentityAttestation: [
          { name: "method", type: "bytes32" },
          { name: "actionType", type: "bytes32" },
          { name: "callerAddress", type: "address" },
          { name: "payeeIdHash", type: "bytes32" },
          { name: "dataHash", type: "bytes32" },
          { name: "issuedAt", type: "uint256" },
          { name: "validUntil", type: "uint256" },
        ],
      },
      {
        method: attestation.method,
        actionType: attestation.actionType,
        callerAddress: attestation.account,
        payeeIdHash: attestation.payeeIdHash,
        dataHash: attestation.dataHash,
        issuedAt: attestation.issuedAtMs,
        validUntil: attestation.validUntilMs,
      },
    );
    await identityRegistry
      .connect(taker.wallet)
      .registerIdentity(attestation, identityAttestor.address, signature);
  }

  async function signal(amount: BigNumber): Promise<string> {
    const params = await createSignalIntentParams(
      orchestrator.address,
      escrow.address,
      ZERO,
      amount,
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
      "0x",
    );
    const receipt = await (await orchestrator.connect(taker.wallet).signalIntent(params)).wait();
    return receipt.events.find((event: any) => event.event === "IntentSignaled").args.intentHash;
  }

  beforeEach(async () => {
    [owner, maker, taker, identityAttestor, caller] = await getAccounts();
    const deployer = new DeployHelper(owner.wallet);
    token = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");
    const paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    const relayerRegistry = await deployer.deployRelayerRegistry();
    const escrowRegistry = await deployer.deployEscrowRegistry();
    const orchestratorRegistry = await deployer.deployOrchestratorRegistry();
    verifier = await deployer.deployPaymentVerifierMock();

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    payeeDetails = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("integration-maker"));
    await paymentVerifierRegistry.addPaymentMethod(paymentMethod, verifier.address, [Currency.USD]);

    escrow = await deployer.deployEscrowV2(
      owner.address,
      ONE,
      orchestratorRegistry.address,
      paymentVerifierRegistry.address,
      owner.address,
      ZERO,
      BigNumber.from(20),
      BigNumber.from(intentExpiration),
    );
    orchestrator = await deployer.deployOrchestratorV2(
      owner.address,
      ONE,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      owner.address,
    );
    await escrowRegistry.addEscrow(escrow.address);
    await orchestratorRegistry.addOrchestrator(orchestrator.address);
    await verifier.setVerificationContext(orchestrator.address, escrow.address);

    identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry", owner.wallet)
    ).deploy(owner.address);
    reputationRegistry = await (
      await ethers.getContractFactory("ReputationRegistry", owner.wallet)
    ).deploy(owner.address, identityRegistry.address);
    stakeVault = await (
      await ethers.getContractFactory("StakeVault", owner.wallet)
    ).deploy(owner.address, token.address);
    riskManager = await (
      await ethers.getContractFactory("ProtocolRiskManager", owner.wallet)
    ).deploy(
      owner.address,
      orchestratorRegistry.address,
      identityRegistry.address,
      reputationRegistry.address,
      stakeVault.address,
    );
    await identityRegistry.setTrustedAttestor(identityAttestor.address, true);
    await identityRegistry.setAcceptedActionType(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes("register_venmo")),
      true,
    );
    await reputationRegistry.setAuthorizedUpdater(riskManager.address, true);
    await stakeVault.setAuthorizedManager(riskManager.address, true);
    await riskManager.setPlatformRiskConfig(paymentMethod, {
      configured: true,
      enabled: true,
      identityRequired: true,
      makerIdentityRequired: false,
      chargebackable: true,
      minReputation: -1_000,
      baseStakeBps: 10_000,
      abandonmentSlashBps: 5_000,
      signalBond: usdc(1),
      maturitySchedule: {
        cliffSeconds: 7 * 24 * 60 * 60,
        stepTwoSeconds: 30 * 24 * 60 * 60,
        finalMaturitySeconds: 180 * 24 * 60 * 60,
        retentionBpsAfterCliff: 10_000,
        retentionBpsAfterStepTwo: 10_000,
      },
    });
    await orchestrator.setRiskManager(riskManager.address);

    await registerTakerIdentity();
    await token.transfer(taker.address, usdc(500));
    await token.connect(taker.wallet).approve(stakeVault.address, usdc(500));
    await stakeVault.connect(taker.wallet).deposit(usdc(500));
    await token.transfer(maker.address, usdc(500));
    await token.connect(maker.wallet).approve(escrow.address, usdc(500));
    await escrow.connect(maker.wallet).createDeposit({
      token: token.address,
      amount: usdc(500),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [paymentMethod],
      paymentMethodData: [{ intentGatingService: ADDRESS_ZERO, payeeDetails, data: "0x" }],
      currencies: [[{
        code: Currency.USD,
        minConversionRate: ether(1),
        oracleRateConfig: EMPTY_ORACLE_RATE_CONFIG,
      }]],
      delegate: ADDRESS_ZERO,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  it("signals and fulfills through the real risk and vault modules", async () => {
    const amount = usdc(100);
    const intentHash = await signal(amount);
    expect(await stakeVault.reservedBalances(taker.address)).to.equal(usdc(126));

    const paymentProof = ethers.utils.defaultAbiCoder.encode(
      ["uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [amount, await time.latest(), payeeDetails, Currency.USD, intentHash],
    );
    await orchestrator.connect(caller.wallet).fulfillIntent({
      paymentProof,
      intentHash,
      verificationData: "0x",
      postIntentHookData: "0x",
    });

    expect(await stakeVault.reservedBalances(taker.address)).to.equal(0);
    expect(await stakeVault.lockedBalances(taker.address)).to.equal(usdc(125));
    expect((await riskManager.intentRisks(intentHash)).status).to.equal(2); // Fulfilled
    expect(await orchestrator.hasActiveIntent(intentHash)).to.equal(false);
  });

  it("cancels through the real modules and clears the durable reputation hold", async () => {
    const intentHash = await signal(usdc(10));
    await orchestrator.connect(taker.wallet).cancelIntent(intentHash);

    expect(await stakeVault.reservedBalances(taker.address)).to.equal(0);
    expect(await stakeVault.reputationHolds(taker.address)).to.equal(0);
    expect(await stakeVault.balances(maker.address)).to.equal(usdc(0.5));
    expect((await riskManager.intentRisks(intentHash)).status).to.equal(3); // Abandoned
    expect((await reputationRegistry.getProfile(taker.address)).abandonedIntents).to.equal(1);
  });

  it("expires and prunes through EscrowV2 without stranding risk collateral", async () => {
    const intentHash = await signal(usdc(10));
    await time.increase(intentExpiration + 1);
    await escrow.connect(caller.wallet).pruneExpiredIntents(ZERO);

    expect(await orchestrator.hasActiveIntent(intentHash)).to.equal(false);
    expect(await stakeVault.reservedBalances(taker.address)).to.equal(0);
    expect(await stakeVault.reputationHolds(taker.address)).to.equal(0);
    expect((await riskManager.intentRisks(intentHash)).status).to.equal(3); // Abandoned
  });

  it("keeps ten real risk-callback prunes below a pinned per-intent gas ceiling", async () => {
    const intentCount = 10;
    for (let i = 0; i < intentCount; i += 1) await signal(usdc(10));
    await time.increase(intentExpiration + 1);
    const receipt = await (await escrow.connect(caller.wallet).pruneExpiredIntents(ZERO)).wait();

    expect(receipt.gasUsed.div(intentCount)).to.be.lt(BigNumber.from(500_000));
    expect(await stakeVault.reservedBalances(taker.address)).to.equal(0);
  });
});
