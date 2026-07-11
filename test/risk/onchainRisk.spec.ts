import "module-alias/register";

import { expect } from "chai";
import { BigNumber, Contract, Signer } from "ethers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (value: number | string): BigNumber => ethers.utils.parseUnits(String(value), 6);

describe("Onchain identity, reputation, and risk", () => {
  let owner: Signer;
  let taker: Signer;
  let maker: Signer;
  let identityAttestor: Signer;
  let chargebackAttestor: Signer;

  let ownerAddress: string;
  let takerAddress: string;
  let makerAddress: string;
  let paymentMethod: string;

  let token: Contract;
  let orchestratorRegistry: Contract;
  let identityRegistry: Contract;
  let reputationRegistry: Contract;
  let stakeVault: Contract;
  let riskManager: Contract;

  async function registerIdentity(account: string, payeeLabel: string, submitter?: Signer): Promise<any> {
    const issuedAtMs = (await time.latest()) * 1_000;
    const validUntilMs = issuedAtMs + 30 * 24 * 60 * 60 * 1_000;
    const actionType = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("register_venmo"));
    const payeeIdHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(payeeLabel));
    const dataHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`identity:${payeeLabel}`));
    const signature = await (identityAttestor as any)._signTypedData(
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
        method: paymentMethod,
        actionType,
        callerAddress: account,
        payeeIdHash,
        dataHash,
        issuedAt: issuedAtMs,
        validUntil: validUntilMs,
      },
    );

    return identityRegistry.connect(submitter || await ethers.getSigner(account)).registerIdentity(
      {
        method: paymentMethod,
        actionType,
        account,
        payeeIdHash,
        dataHash,
        issuedAtMs,
        validUntilMs,
      },
      await identityAttestor.getAddress(),
      signature,
    );
  }

  beforeEach(async () => {
    [owner, taker, maker, identityAttestor, chargebackAttestor] = await ethers.getSigners();
    ownerAddress = await owner.getAddress();
    takerAddress = await taker.getAddress();
    makerAddress = await maker.getAddress();
    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));

    token = await (await ethers.getContractFactory("USDCMock", owner)).deploy(usdc(1_000_000), "USDC", "USDC");
    orchestratorRegistry = await (await ethers.getContractFactory("OrchestratorRegistry", owner)).deploy();
    identityRegistry = await (
      await ethers.getContractFactory("IdentityRegistry", owner)
    ).deploy(ownerAddress);
    reputationRegistry = await (
      await ethers.getContractFactory("ReputationRegistry", owner)
    ).deploy(ownerAddress, identityRegistry.address);
    stakeVault = await (
      await ethers.getContractFactory("StakeVault", owner)
    ).deploy(ownerAddress, token.address);
    riskManager = await (
      await ethers.getContractFactory("ProtocolRiskManager", owner)
    ).deploy(
      ownerAddress,
      orchestratorRegistry.address,
      identityRegistry.address,
      reputationRegistry.address,
      stakeVault.address,
    );

    await orchestratorRegistry.addOrchestrator(ownerAddress);
    await identityRegistry.setTrustedAttestor(await identityAttestor.getAddress(), true);
    await identityRegistry.setAcceptedActionType(
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes("register_venmo")),
      true,
    );
    await reputationRegistry.setAuthorizedUpdater(riskManager.address, true);
    await stakeVault.setAuthorizedManager(riskManager.address, true);
    await riskManager.setTrustedChargebackAttestor(await chargebackAttestor.getAddress(), true);

    await riskManager.setPlatformRiskConfig(paymentMethod, {
      configured: true,
      enabled: true,
      identityRequired: true,
      makerIdentityRequired: false,
      chargebackable: true,
      minReputation: 0,
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

    await token.transfer(takerAddress, usdc(500));
    await token.connect(taker).approve(stakeVault.address, usdc(500));
    await stakeVault.connect(taker).deposit(usdc(500));
  });

  it("enforces unique identity and capital instead of backend signatures or amount caps", async () => {
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-1"));
    const context = {
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(100),
    };

    await expect(riskManager.onIntentSignaled(context)).to.be.revertedWithCustomError(
      riskManager,
      "IdentityRequired",
    );

    await expect(registerIdentity(takerAddress, "taker-payee", owner)).to.be.revertedWithCustomError(
      identityRegistry,
      "UnauthorizedAccount",
    );
    await registerIdentity(takerAddress, "taker-payee");
    await expect(registerIdentity(makerAddress, "taker-payee")).to.be.revertedWithCustomError(
      identityRegistry,
      "IdentityAlreadyBound",
    );
    await registerIdentity(makerAddress, "maker-payee");

    await expect(
      riskManager.onIntentSignaled({ ...context, maker: takerAddress }),
    ).to.be.revertedWithCustomError(riskManager, "SelfInteraction");

    await expect(riskManager.onIntentSignaled(context))
      .to.emit(riskManager, "IntentRiskReserved")
      .withArgs(intentHash, takerAddress, paymentMethod, 0, usdc(1), usdc(125), 0);

    expect(await stakeVault.reservedBalances(takerAddress)).to.equal(usdc(126));
    await riskManager.onIntentFulfilled(intentHash, usdc(100), true);
    expect(await stakeVault.lockedBalances(takerAddress)).to.equal(usdc(125));

    const profile = await reputationRegistry.getProfile(takerAddress);
    expect(profile.successfulInteractions).to.equal(1);
    expect(profile.score).to.be.gt(0);
  });

  it("awards no flat reward after a verified graph edge reaches its cap", async () => {
    await registerIdentity(takerAddress, "taker-payee");
    await registerIdentity(makerAddress, "maker-payee");
    await reputationRegistry.setAuthorizedUpdater(ownerAddress, true);

    await reputationRegistry.recordSuccess(takerAddress, makerAddress, usdc(10_000));
    const cappedScore = (await reputationRegistry.getProfile(takerAddress)).score;
    expect(cappedScore).to.equal(100);

    await reputationRegistry.recordSuccess(takerAddress, makerAddress, usdc(10_000));
    expect((await reputationRegistry.getProfile(takerAddress)).score).to.equal(cappedScore);
  });

  it("rotates the canonical reputation node when an identity is deactivated", async () => {
    await registerIdentity(takerAddress, "taker-primary");
    await registerIdentity(takerAddress, "taker-secondary");
    const identities = await identityRegistry.getAccountIdentities(takerAddress);
    expect(await identityRegistry.getAccountNode(takerAddress)).to.equal(identities[0]);

    await identityRegistry.setIdentityStatus(identities[0], false);
    expect(await identityRegistry.isVerifiedAccount(takerAddress)).to.equal(true);
    expect(await identityRegistry.getAccountNode(takerAddress)).to.equal(identities[1]);

    await identityRegistry.setAccountQuarantine(takerAddress, true);
    expect(await identityRegistry.isVerifiedAccount(takerAddress)).to.equal(false);
    expect(await identityRegistry.isQuarantined(takerAddress)).to.equal(true);
  });

  it("keeps full-window coverage and resolves cumulative signed chargebacks", async () => {
    await registerIdentity(takerAddress, "taker-payee");
    await registerIdentity(makerAddress, "maker-payee");

    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-2"));
    await riskManager.onIntentSignaled({
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(100),
    });
    await riskManager.onIntentFulfilled(intentHash, usdc(100), true);

    await time.increase(8 * 24 * 60 * 60);
    expect(await stakeVault.getRequiredLocked(intentHash)).to.equal(usdc(125));

    const issuedAt = await time.latest();
    const validUntil = issuedAt + 60 * 60;
    const evidenceHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("chargeback-evidence"));
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const chargebackTypes = {
      ChargebackAttestation: [
        { name: "intentHash", type: "bytes32" },
        { name: "taker", type: "address" },
        { name: "maker", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "paymentMethod", type: "bytes32" },
        { name: "evidenceHash", type: "bytes32" },
        { name: "finalClaim", type: "bool" },
        { name: "issuedAt", type: "uint256" },
        { name: "validUntil", type: "uint256" },
      ],
    };
    const signature = await (chargebackAttestor as any)._signTypedData(
      {
        name: "ZKP2PChargebackVerifier",
        version: "1",
        chainId,
        verifyingContract: riskManager.address,
      },
      chargebackTypes,
      {
        intentHash,
        taker: takerAddress,
        maker: makerAddress,
        amount: usdc(80),
        paymentMethod,
        evidenceHash,
        finalClaim: false,
        issuedAt,
        validUntil,
      },
    );

    const makerBalanceBefore = await stakeVault.balances(makerAddress);
    await expect(
      riskManager.resolveChargeback(
        {
          intentHash,
          taker: takerAddress,
          maker: makerAddress,
          amount: usdc(80),
          paymentMethod,
          evidenceHash,
          finalClaim: false,
          issuedAt,
          validUntil,
        },
        await chargebackAttestor.getAddress(),
        signature,
      ),
    )
      .to.emit(riskManager, "ChargebackResolved")
      .withArgs(intentHash, takerAddress, makerAddress, usdc(80), usdc(80), false, evidenceHash);

    expect((await stakeVault.balances(makerAddress)).sub(makerBalanceBefore)).to.equal(usdc(80));
    expect(await stakeVault.lockedBalances(takerAddress)).to.equal(usdc(45));
    expect((await reputationRegistry.getProfile(takerAddress)).chargebacks).to.equal(1);
    expect(await stakeVault.openChargebackClaims(takerAddress)).to.equal(1);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(0);
    await expect(
      riskManager.onIntentSignaled({
        intentHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("blocked-by-open-chargeback")),
        taker: takerAddress,
        maker: makerAddress,
        token: token.address,
        paymentMethod,
        amount: usdc(10),
      }),
    ).to.be.revertedWithCustomError(riskManager, "AccountRiskHold");

    const replacementRiskManager = await (
      await ethers.getContractFactory("ProtocolRiskManager", owner)
    ).deploy(
      ownerAddress,
      orchestratorRegistry.address,
      identityRegistry.address,
      reputationRegistry.address,
      stakeVault.address,
    );
    await replacementRiskManager.setPlatformRiskConfig(paymentMethod, {
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
    await expect(
      replacementRiskManager.onIntentSignaled({
        intentHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("blocked-after-manager-upgrade")),
        taker: takerAddress,
        maker: makerAddress,
        token: token.address,
        paymentMethod,
        amount: usdc(10),
      }),
    ).to.be.revertedWithCustomError(replacementRiskManager, "AccountRiskHold");

    await expect(riskManager.closeStaleChargebackClaim(intentHash)).to.be.revertedWithCustomError(
      riskManager,
      "ChargebackClaimNotStale",
    );
    await time.increase(await riskManager.MAX_OPEN_CLAIM_SECONDS());
    await riskManager.connect(maker).closeStaleChargebackClaim(intentHash);
    expect(await stakeVault.openChargebackClaims(takerAddress)).to.equal(0);

    const finalEvidenceHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("final-chargeback-evidence"));
    const finalIssuedAt = await time.latest();
    const finalAttestation = {
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      amount: usdc(20),
      paymentMethod,
      evidenceHash: finalEvidenceHash,
      finalClaim: true,
      issuedAt: finalIssuedAt,
      validUntil: finalIssuedAt + 60 * 60,
    };
    const finalSignature = await (chargebackAttestor as any)._signTypedData(
      {
        name: "ZKP2PChargebackVerifier",
        version: "1",
        chainId,
        verifyingContract: riskManager.address,
      },
      chargebackTypes,
      finalAttestation,
    );
    await riskManager.resolveChargeback(
      finalAttestation,
      await chargebackAttestor.getAddress(),
      finalSignature,
    );

    const resolvedRisk = await riskManager.intentRisks(intentHash);
    expect(resolvedRisk.status).to.equal(4); // ChargedBack
    expect(resolvedRisk.cumulativeChargebackAmount).to.equal(usdc(100));
    expect(resolvedRisk.cumulativeCompensation).to.equal(usdc(100));
    expect(await stakeVault.lockedBalances(takerAddress)).to.equal(0);
    expect((await reputationRegistry.getProfile(takerAddress)).chargebacks).to.equal(1);
    expect(await stakeVault.openChargebackClaims(takerAddress)).to.equal(0);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(0);
  });

  it("penalizes unfulfilled locks and credits the signal bond to the maker", async () => {
    await registerIdentity(takerAddress, "taker-payee");
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-3"));
    await riskManager.onIntentSignaled({
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(10),
    });

    const makerBalanceBefore = await stakeVault.balances(makerAddress);
    await riskManager.onIntentAbandoned(intentHash, true);

    expect((await stakeVault.balances(makerAddress)).sub(makerBalanceBefore)).to.equal(usdc(0.5));
    const profile = await reputationRegistry.getProfile(takerAddress);
    expect(profile.abandonedIntents).to.equal(1);
    expect(profile.score).to.be.lt(0);

    const ownerBalanceBefore = await token.balanceOf(ownerAddress);
    await stakeVault.connect(maker).withdraw(usdc(0.5), ownerAddress);
    expect((await token.balanceOf(ownerAddress)).sub(ownerBalanceBefore)).to.equal(usdc(0.5));
  });

  it("replays a failed chargeback penalty without losing its one-time base penalty", async () => {
    await registerIdentity(takerAddress, "taker-payee");
    await registerIdentity(makerAddress, "maker-payee");
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("chargeback-reputation-retry"));
    await riskManager.onIntentSignaled({
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(100),
    });
    await riskManager.onIntentFulfilled(intentHash, usdc(100), true);
    await reputationRegistry.setAuthorizedUpdater(riskManager.address, false);

    const issuedAt = await time.latest();
    const attestation = {
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      amount: usdc(100),
      paymentMethod,
      evidenceHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("retry-evidence")),
      finalClaim: true,
      issuedAt,
      validUntil: issuedAt + 60 * 60,
    };
    const signature = await (chargebackAttestor as any)._signTypedData(
      {
        name: "ZKP2PChargebackVerifier",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: riskManager.address,
      },
      {
        ChargebackAttestation: [
          { name: "intentHash", type: "bytes32" },
          { name: "taker", type: "address" },
          { name: "maker", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "paymentMethod", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "finalClaim", type: "bool" },
          { name: "issuedAt", type: "uint256" },
          { name: "validUntil", type: "uint256" },
        ],
      },
      attestation,
    );

    await expect(
      riskManager.resolveChargeback(
        attestation,
        await chargebackAttestor.getAddress(),
        signature,
      ),
    ).to.emit(riskManager, "ReputationUpdateFailed");
    expect((await reputationRegistry.getProfile(takerAddress)).chargebacks).to.equal(0);
    expect(await stakeVault.openChargebackClaims(takerAddress)).to.equal(0);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(1);
    await expect(
      riskManager.onIntentSignaled({
        intentHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("blocked-by-chargeback-sync")),
        taker: takerAddress,
        maker: makerAddress,
        token: token.address,
        paymentMethod,
        amount: usdc(10),
      }),
    ).to.be.revertedWithCustomError(riskManager, "AccountRiskHold");

    await reputationRegistry.setAuthorizedUpdater(riskManager.address, true);
    await riskManager.connect(maker).syncReputation(intentHash);
    await riskManager.connect(maker).syncReputation(intentHash);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(0);
    expect((await reputationRegistry.getProfile(takerAddress)).chargebacks).to.equal(1);
    expect((await riskManager.intentRisks(intentHash)).reputationChargebackAmount).to.equal(usdc(100));
  });

  it("keeps a durable hold and permissionlessly replays a failed abandonment penalty", async () => {
    await registerIdentity(takerAddress, "taker-payee");
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("intent-reputation-retry"));
    await riskManager.onIntentSignaled({
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(10),
    });

    await reputationRegistry.setAuthorizedUpdater(riskManager.address, false);
    await expect(riskManager.onIntentAbandoned(intentHash, false)).to.emit(
      riskManager,
      "ReputationUpdateFailed",
    );
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(1);
    await expect(
      riskManager.onIntentSignaled({
        intentHash: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("blocked-by-pending-reputation")),
        taker: takerAddress,
        maker: makerAddress,
        token: token.address,
        paymentMethod,
        amount: usdc(10),
      }),
    ).to.be.revertedWithCustomError(riskManager, "AccountRiskHold");

    await reputationRegistry.setAuthorizedUpdater(riskManager.address, true);
    await riskManager.connect(maker).syncReputation(intentHash);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(0);
    expect((await reputationRegistry.getProfile(takerAddress)).abandonedIntents).to.equal(1);
  });

  it("rejects reputation parameters that could overflow or disable penalties", async () => {
    await expect(
      reputationRegistry.setReputationConfig(1, 100, 0, 100, 10, 20_000),
    ).to.be.revertedWithCustomError(reputationRegistry, "InvalidConfig");
    await expect(
      reputationRegistry.setReputationConfig(1, 100, 10, 100, 10_001, 20_000),
    ).to.be.revertedWithCustomError(reputationRegistry, "InvalidConfig");
  });

  it("recovers a dropped reservation permissionlessly but never slashes a live intent", async () => {
    await registerIdentity(takerAddress, "recovery-taker");
    const lifecycleCaller = await (
      await ethers.getContractFactory("IntentStatusOrchestratorMock", owner)
    ).deploy();
    await orchestratorRegistry.addOrchestrator(lifecycleCaller.address);
    const intentHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("orphaned-reservation"));
    await lifecycleCaller.signal(riskManager.address, {
      intentHash,
      taker: takerAddress,
      maker: makerAddress,
      token: token.address,
      paymentMethod,
      amount: usdc(10),
    });

    await expect(riskManager.connect(maker).recoverOrphanedReservation(intentHash))
      .to.be.revertedWithCustomError(riskManager, "IntentStillActive");

    await lifecycleCaller.dropIntent(intentHash);
    await riskManager.connect(maker).recoverOrphanedReservation(intentHash);
    expect(await stakeVault.reservedBalances(takerAddress)).to.equal(0);
    expect(await stakeVault.reputationHolds(takerAddress)).to.equal(0);
    expect(await stakeVault.balances(makerAddress)).to.equal(usdc(0.5));
    expect((await riskManager.intentRisks(intentHash)).status).to.equal(3); // Abandoned
  });
});
