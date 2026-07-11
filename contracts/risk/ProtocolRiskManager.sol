// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IIdentityRegistry } from "../interfaces/IIdentityRegistry.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IProtocolRiskManager } from "../interfaces/IProtocolRiskManager.sol";
import { IReputationRegistry } from "../interfaces/IReputationRegistry.sol";
import { IStakeVault } from "../interfaces/IStakeVault.sol";

interface IIntentStatusView {
    function hasActiveIntent(bytes32 intentHash) external view returns (bool);
}

/**
 * @title ProtocolRiskManager
 * @notice Transparent onchain platform policy, reputation tiers, stake quoting, and lifecycle accounting.
 * @dev There are deliberately no per-tier amount caps or active-intent count limits. Access is controlled
 *      by unique identity, a configurable minimum reputation floor, and capital reserved per intent.
 *      Orchestrators snapshot this contract per intent, so a later module upgrade cannot strand positions.
 */
contract ProtocolRiskManager is Ownable, EIP712, IProtocolRiskManager {
    using SignatureChecker for address;

    uint16 private constant BPS = 10_000;
    uint16 private constant MAX_STAKE_BPS = 20_000;
    uint16 private constant MAX_TIER_STAKE_MULTIPLIER_BPS = 20_000;
    uint256 public constant MAX_FUTURE_ISSUANCE = 5 minutes;
    uint256 public constant MAX_OPEN_CLAIM_SECONDS = 30 days;

    bytes32 public constant CHARGEBACK_TYPEHASH = keccak256(
        "ChargebackAttestation(bytes32 intentHash,address taker,address maker,uint256 amount,bytes32 paymentMethod,bytes32 evidenceHash,bool finalClaim,uint256 issuedAt,uint256 validUntil)"
    );

    enum IntentRiskStatus {
        None,
        Reserved,
        Fulfilled,
        Abandoned,
        ChargedBack
    }

    struct PlatformRiskConfig {
        bool configured;
        bool enabled;
        bool identityRequired;
        bool makerIdentityRequired;
        bool chargebackable;
        int256 minReputation;
        uint16 baseStakeBps;
        uint16 abandonmentSlashBps;
        uint96 signalBond;
        IStakeVault.MaturitySchedule maturitySchedule;
    }

    struct TierConfig {
        int256 minReputation;
        uint16 feeDiscountBps;
        uint16 stakeMultiplierBps;
    }

    struct IntentRisk {
        address orchestrator;
        address taker;
        address maker;
        bytes32 paymentMethod;
        uint256 signaledAmount;
        uint256 releaseAmount;
        uint16 feeDiscountBps;
        uint16 baseStakeBps;
        uint16 tierStakeMultiplierBps;
        uint16 abandonmentSlashBps;
        uint256 cumulativeChargebackAmount;
        uint256 cumulativeCompensation;
        uint256 reputationChargebackAmount;
        uint64 lastChargebackAt;
        bool abandonmentExpired;
        bool abandonmentReputationRecorded;
        IStakeVault.MaturitySchedule maturitySchedule;
        IntentRiskStatus status;
    }

    struct ChargebackAttestation {
        bytes32 intentHash;
        address taker;
        address maker;
        uint256 amount;
        bytes32 paymentMethod;
        bytes32 evidenceHash;
        bool finalClaim;
        uint256 issuedAt;
        uint256 validUntil;
    }

    IIdentityRegistry public immutable identityRegistry;
    IReputationRegistry public immutable reputationRegistry;
    IStakeVault public immutable stakeVault;
    IOrchestratorRegistry public immutable orchestratorRegistry;

    mapping(bytes32 => PlatformRiskConfig) public platformRiskConfigs;
    mapping(bytes32 => IntentRisk) public intentRisks;
    mapping(bytes32 => bool) public usedChargebackEvidence;
    mapping(address => bool) public trustedChargebackAttestors;
    TierConfig[] private tierConfigs;

    event PlatformRiskConfigUpdated(bytes32 indexed paymentMethod, PlatformRiskConfig config);
    event TierConfigsUpdated(uint256 tierCount);
    event TrustedChargebackAttestorUpdated(address indexed attestor, bool trusted);
    event IntentRiskReserved(
        bytes32 indexed intentHash,
        address indexed taker,
        bytes32 indexed paymentMethod,
        uint8 tier,
        uint256 bondAmount,
        uint256 riskAmount,
        uint16 feeDiscountBps
    );
    event IntentRiskFulfilled(
        bytes32 indexed intentHash,
        uint256 releaseAmount,
        uint256 activatedRiskAmount,
        bool paymentProofVerified
    );
    event IntentRiskAbandoned(bytes32 indexed intentHash, bool expired);
    event ReputationUpdateFailed(bytes32 indexed intentHash, bytes reason);
    event ReputationSynchronized(bytes32 indexed intentHash, uint256 chargebackAmount, bool abandonmentRecorded);
    event ChargebackResolved(
        bytes32 indexed intentHash,
        address indexed taker,
        address indexed maker,
        uint256 attestedAmount,
        uint256 paidAmount,
        bool finalClaim,
        bytes32 evidenceHash
    );
    event StaleChargebackClaimClosed(bytes32 indexed intentHash, address indexed taker);

    error ZeroAddress();
    error UnauthorizedOrchestrator(address caller);
    error InvalidPlatformConfig(bytes32 paymentMethod);
    error PlatformNotConfigured(bytes32 paymentMethod);
    error PlatformDisabled(bytes32 paymentMethod);
    error IdentityRequired(address account);
    error AccountQuarantined(address account);
    error ReputationBelowMinimum(address account, int256 score, int256 minimum);
    error SelfInteraction(address account);
    error UnsupportedCollateralToken(address token, address requiredToken);
    error IntentRiskAlreadyExists(bytes32 intentHash);
    error IntentRiskNotFound(bytes32 intentHash);
    error InvalidIntentRiskStatus(bytes32 intentHash, IntentRiskStatus status);
    error IntentOrchestratorMismatch(address caller, address expected);
    error InvalidTierConfig(uint256 index);
    error UntrustedChargebackAttestor(address attestor);
    error InvalidChargebackAttestation();
    error InvalidChargebackTime(uint256 issuedAt, uint256 validUntil, uint256 currentTime);
    error InvalidChargebackSignature();
    error IntentStillActive(bytes32 intentHash);
    error ChargebackEvidenceAlreadyUsed(bytes32 evidenceKey);
    error AccountRiskHold(address account, uint256 openClaimCount, uint256 reputationHoldCount);
    error ChargebackClaimNotStale(bytes32 intentHash, uint256 eligibleAt, uint256 currentTime);

    modifier onlyOrchestrator() {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestrator(msg.sender);
        _;
    }

    constructor(
        address owner_,
        IOrchestratorRegistry orchestratorRegistry_,
        IIdentityRegistry identityRegistry_,
        IReputationRegistry reputationRegistry_,
        IStakeVault stakeVault_
    ) EIP712("ZKP2PChargebackVerifier", "1") {
        if (
            owner_ == address(0)
                || address(orchestratorRegistry_) == address(0)
                || address(identityRegistry_) == address(0)
                || address(reputationRegistry_) == address(0)
                || address(stakeVault_) == address(0)
        ) revert ZeroAddress();

        orchestratorRegistry = orchestratorRegistry_;
        identityRegistry = identityRegistry_;
        reputationRegistry = reputationRegistry_;
        stakeVault = stakeVault_;
        _setDefaultTiers();
        transferOwnership(owner_);
    }

    /** @notice Stores every platform risk lever onchain in one auditable record. */
    function setPlatformRiskConfig(bytes32 paymentMethod, PlatformRiskConfig calldata config) external onlyOwner {
        if (paymentMethod == bytes32(0) || !config.configured) revert InvalidPlatformConfig(paymentMethod);
        if (
            config.baseStakeBps > MAX_STAKE_BPS
                || config.abandonmentSlashBps > BPS
                || (config.chargebackable && config.baseStakeBps < BPS)
                || (!config.chargebackable && config.baseStakeBps != 0)
        ) revert InvalidPlatformConfig(paymentMethod);

        if (config.chargebackable) {
            IStakeVault.MaturitySchedule calldata schedule = config.maturitySchedule;
            if (
                schedule.cliffSeconds == 0
                    || schedule.stepTwoSeconds <= schedule.cliffSeconds
                    || schedule.finalMaturitySeconds <= schedule.stepTwoSeconds
                    || schedule.retentionBpsAfterCliff != BPS
                    || schedule.retentionBpsAfterStepTwo != BPS
            ) revert InvalidPlatformConfig(paymentMethod);
        }

        platformRiskConfigs[paymentMethod] = config;
        emit PlatformRiskConfigUpdated(paymentMethod, config);
    }

    /**
     * @notice Replaces the ordered tier table after monotonicity checks.
     * @dev Discounts are a percentage of the protocol fee, not an amount cap. Stake multipliers
     *      must fall as reputation rises. At least one bootstrap tier is always required.
     */
    function setTierConfigs(TierConfig[] calldata configs) external onlyOwner {
        if (configs.length == 0 || configs.length > 16) revert InvalidTierConfig(0);
        delete tierConfigs;
        for (uint256 i = 0; i < configs.length; ++i) {
            TierConfig calldata config = configs[i];
            if (
                config.feeDiscountBps > BPS
                    || config.stakeMultiplierBps < BPS
                    || config.stakeMultiplierBps > MAX_TIER_STAKE_MULTIPLIER_BPS
                    || (i > 0 && config.minReputation <= configs[i - 1].minReputation)
                    || (i > 0 && config.feeDiscountBps < configs[i - 1].feeDiscountBps)
                    || (i > 0 && config.stakeMultiplierBps > configs[i - 1].stakeMultiplierBps)
            ) revert InvalidTierConfig(i);
            tierConfigs.push(config);
        }
        emit TierConfigsUpdated(configs.length);
    }

    function setTrustedChargebackAttestor(address attestor, bool trusted) external onlyOwner {
        if (attestor == address(0)) revert ZeroAddress();
        trustedChargebackAttestors[attestor] = trusted;
        emit TrustedChargebackAttestorUpdated(attestor, trusted);
    }

    function getTierConfig(uint256 tier) external view returns (TierConfig memory) {
        return tierConfigs[tier];
    }

    function getTierCount() external view returns (uint256) {
        return tierConfigs.length;
    }

    function getTier(address account) public view returns (uint8 tier) {
        int256 score = reputationRegistry.getScore(account);
        for (uint256 i = 1; i < tierConfigs.length; ++i) {
            if (score < tierConfigs[i].minReputation) break;
            tier = uint8(i);
        }
    }

    /** @notice Validates identity/reputation policy and reserves bond plus chargeback collateral. */
    function onIntentSignaled(SignalContext calldata context)
        external
        override
        onlyOrchestrator
        returns (uint16 feeDiscountBps)
    {
        if (intentRisks[context.intentHash].status != IntentRiskStatus.None) {
            revert IntentRiskAlreadyExists(context.intentHash);
        }
        if (context.taker == context.maker) revert SelfInteraction(context.taker);
        uint256 openClaimCount = stakeVault.openChargebackClaims(context.taker);
        uint256 reputationHoldCount = stakeVault.reputationHolds(context.taker);
        if (openClaimCount > 0 || reputationHoldCount > 0) {
            revert AccountRiskHold(context.taker, openClaimCount, reputationHoldCount);
        }
        PlatformRiskConfig memory platform = platformRiskConfigs[context.paymentMethod];
        if (!platform.configured) revert PlatformNotConfigured(context.paymentMethod);
        if (!platform.enabled) revert PlatformDisabled(context.paymentMethod);
        if (identityRegistry.isQuarantined(context.taker)) revert AccountQuarantined(context.taker);
        if (identityRegistry.isQuarantined(context.maker)) revert AccountQuarantined(context.maker);
        if (platform.identityRequired && !identityRegistry.isVerifiedAccount(context.taker)) {
            revert IdentityRequired(context.taker);
        }
        if (platform.makerIdentityRequired && !identityRegistry.isVerifiedAccount(context.maker)) {
            revert IdentityRequired(context.maker);
        }

        int256 score = reputationRegistry.getScore(context.taker);
        if (score < platform.minReputation) {
            revert ReputationBelowMinimum(context.taker, score, platform.minReputation);
        }

        uint8 tier = getTier(context.taker);
        TierConfig memory tierConfig = tierConfigs[tier];
        uint256 riskAmount = _calculateRiskAmount(
            context.amount,
            platform.baseStakeBps,
            tierConfig.stakeMultiplierBps
        );
        uint256 bondAmount = platform.signalBond;
        if (
            bondAmount + riskAmount > 0
                && context.token != address(stakeVault.stakeToken())
        ) {
            revert UnsupportedCollateralToken(context.token, address(stakeVault.stakeToken()));
        }

        intentRisks[context.intentHash] = IntentRisk({
            orchestrator: msg.sender,
            taker: context.taker,
            maker: context.maker,
            paymentMethod: context.paymentMethod,
            signaledAmount: context.amount,
            releaseAmount: 0,
            feeDiscountBps: tierConfig.feeDiscountBps,
            baseStakeBps: platform.baseStakeBps,
            tierStakeMultiplierBps: tierConfig.stakeMultiplierBps,
            abandonmentSlashBps: platform.abandonmentSlashBps,
            cumulativeChargebackAmount: 0,
            cumulativeCompensation: 0,
            reputationChargebackAmount: 0,
            lastChargebackAt: 0,
            abandonmentExpired: false,
            abandonmentReputationRecorded: false,
            maturitySchedule: platform.maturitySchedule,
            status: IntentRiskStatus.Reserved
        });

        stakeVault.reserve(
            context.intentHash,
            context.taker,
            context.maker,
            context.paymentMethod,
            bondAmount,
            riskAmount
        );

        feeDiscountBps = tierConfig.feeDiscountBps;
        emit IntentRiskReserved(
            context.intentHash,
            context.taker,
            context.paymentMethod,
            tier,
            bondAmount,
            riskAmount,
            feeDiscountBps
        );
    }

    /** @notice Activates chargeback collateral and records a successful graph interaction. */
    function onIntentFulfilled(bytes32 intentHash, uint256 releaseAmount, bool paymentProofVerified)
        external
        override
    {
        IntentRisk storage intentRisk = _getReservedIntentRisk(intentHash);
        _validateIntentOrchestrator(intentRisk);
        if (releaseAmount == 0 || releaseAmount > intentRisk.signaledAmount) {
            revert InvalidChargebackAttestation();
        }

        uint256 activatedRiskAmount = _calculateRiskAmount(
            releaseAmount,
            intentRisk.baseStakeBps,
            intentRisk.tierStakeMultiplierBps
        );
        stakeVault.activate(intentHash, activatedRiskAmount, intentRisk.maturitySchedule);
        if (paymentProofVerified) {
            try reputationRegistry.recordSuccess(intentRisk.taker, intentRisk.maker, releaseAmount) {
                // Reputation is accounted synchronously when its reporter authorization is healthy.
            } catch (bytes memory reason) {
                // Settlement and collateral accounting must not depend on the reputation reporter.
                emit ReputationUpdateFailed(intentHash, reason);
            }
        }

        intentRisk.releaseAmount = releaseAmount;
        intentRisk.status = IntentRiskStatus.Fulfilled;
        emit IntentRiskFulfilled(intentHash, releaseAmount, activatedRiskAmount, paymentProofVerified);
    }

    /** @notice Releases a reservation, applies the bond slash, and records an abandonment penalty. */
    function onIntentAbandoned(bytes32 intentHash, bool expired) external override {
        IntentRisk storage intentRisk = _getReservedIntentRisk(intentHash);
        _validateIntentOrchestrator(intentRisk);

        stakeVault.abandon(intentHash, intentRisk.abandonmentSlashBps);
        intentRisk.abandonmentExpired = expired;
        intentRisk.status = IntentRiskStatus.Abandoned;
        _syncAbandonmentReputation(intentHash, intentRisk);
        emit IntentRiskAbandoned(intentHash, expired);
    }

    /**
     * @notice Resolves a reservation if Orchestrator fail-open pruning skipped a broken callback.
     * @dev Anyone may call, but only after the snapshotted orchestrator confirms the intent is gone.
     */
    function recoverOrphanedReservation(bytes32 intentHash) external {
        IntentRisk storage intentRisk = _getReservedIntentRisk(intentHash);
        if (IIntentStatusView(intentRisk.orchestrator).hasActiveIntent(intentHash)) {
            revert IntentStillActive(intentHash);
        }

        stakeVault.abandon(intentHash, intentRisk.abandonmentSlashBps);
        // Recovery is deliberately conservative because the failed callback's cancellation/expiry
        // classification is no longer authoritative after the orchestrator prunes its intent.
        intentRisk.abandonmentExpired = true;
        intentRisk.status = IntentRiskStatus.Abandoned;
        _syncAbandonmentReputation(intentHash, intentRisk);
        emit IntentRiskAbandoned(intentHash, true);
    }

    /**
     * @notice Credits a maker from still-locked collateral after a trusted Attestor confirms a chargeback.
     * @dev The EIP-712 domain includes chain id and this verifying contract, preventing cross-chain replay.
     */
    function resolveChargeback(
        ChargebackAttestation calldata attestation,
        address attestor,
        bytes calldata signature
    ) external returns (uint256 paidAmount) {
        if (!trustedChargebackAttestors[attestor]) revert UntrustedChargebackAttestor(attestor);
        IntentRisk storage intentRisk = intentRisks[attestation.intentHash];
        if (intentRisk.status != IntentRiskStatus.Fulfilled) {
            revert InvalidIntentRiskStatus(attestation.intentHash, intentRisk.status);
        }
        if (
            attestation.taker != intentRisk.taker
                || attestation.maker != intentRisk.maker
                || attestation.paymentMethod != intentRisk.paymentMethod
                || attestation.amount == 0
                || attestation.evidenceHash == bytes32(0)
        ) revert InvalidChargebackAttestation();
        uint256 remainingChargebackAmount = intentRisk.releaseAmount - intentRisk.cumulativeChargebackAmount;
        if (attestation.amount > remainingChargebackAmount) revert InvalidChargebackAttestation();
        bytes32 evidenceKey = keccak256(abi.encode(attestation.intentHash, attestation.evidenceHash));
        if (usedChargebackEvidence[evidenceKey]) revert ChargebackEvidenceAlreadyUsed(evidenceKey);
        if (
            attestation.issuedAt > block.timestamp + MAX_FUTURE_ISSUANCE
                || attestation.validUntil < block.timestamp
                || attestation.validUntil < attestation.issuedAt
        ) {
            revert InvalidChargebackTime(attestation.issuedAt, attestation.validUntil, block.timestamp);
        }

        bytes32 structHash = keccak256(
            abi.encode(
                CHARGEBACK_TYPEHASH,
                attestation.intentHash,
                attestation.taker,
                attestation.maker,
                attestation.amount,
                attestation.paymentMethod,
                attestation.evidenceHash,
                attestation.finalClaim,
                attestation.issuedAt,
                attestation.validUntil
            )
        );
        if (!attestor.isValidSignatureNow(_hashTypedDataV4(structHash), signature)) {
            revert InvalidChargebackSignature();
        }

        if (!attestation.finalClaim && attestation.amount == remainingChargebackAmount) {
            revert InvalidChargebackAttestation();
        }
        usedChargebackEvidence[evidenceKey] = true;
        paidAmount = stakeVault.resolveChargeback(
            attestation.intentHash,
            attestation.amount,
            attestation.finalClaim
        );
        intentRisk.cumulativeChargebackAmount += attestation.amount;
        intentRisk.cumulativeCompensation += paidAmount;
        if (attestation.finalClaim) {
            intentRisk.lastChargebackAt = 0;
            intentRisk.status = IntentRiskStatus.ChargedBack;
        } else {
            intentRisk.lastChargebackAt = uint64(block.timestamp);
        }
        _syncChargebackReputation(attestation.intentHash, intentRisk);

        emit ChargebackResolved(
            attestation.intentHash,
            attestation.taker,
            attestation.maker,
            attestation.amount,
            paidAmount,
            attestation.finalClaim,
            attestation.evidenceHash
        );
    }

    /**
     * @notice Permissionlessly removes an access freeze if a partial claim is not finalized in time.
     * @dev This does not release collateral or prevent a later valid attestation. It only restores
     *      protocol access after the Attestor's bounded finalization window lapses.
     */
    function closeStaleChargebackClaim(bytes32 intentHash) external {
        IntentRisk storage intentRisk = intentRisks[intentHash];
        if (intentRisk.status != IntentRiskStatus.Fulfilled || !stakeVault.hasOpenChargebackClaim(intentHash)) {
            revert InvalidIntentRiskStatus(intentHash, intentRisk.status);
        }
        uint256 eligibleAt = uint256(intentRisk.lastChargebackAt) + MAX_OPEN_CLAIM_SECONDS;
        if (intentRisk.lastChargebackAt == 0 || block.timestamp < eligibleAt) {
            revert ChargebackClaimNotStale(intentHash, eligibleAt, block.timestamp);
        }

        stakeVault.closeChargebackClaim(intentHash);
        intentRisk.lastChargebackAt = 0;
        emit StaleChargebackClaimClosed(intentHash, intentRisk.taker);
    }

    /**
     * @notice Permissionlessly retries a negative reputation update that previously failed.
     * @dev StakeVault keeps a shared account hold until synchronization succeeds, so a manager
     *      upgrade cannot let an account bypass a pending abandonment or chargeback penalty.
     */
    function syncReputation(bytes32 intentHash) external override returns (bool synced) {
        IntentRisk storage intentRisk = intentRisks[intentHash];
        if (intentRisk.status == IntentRiskStatus.None) revert IntentRiskNotFound(intentHash);
        if (intentRisk.status == IntentRiskStatus.Abandoned) {
            return _syncAbandonmentReputation(intentHash, intentRisk);
        }
        if (
            intentRisk.status == IntentRiskStatus.Fulfilled
                || intentRisk.status == IntentRiskStatus.ChargedBack
        ) {
            return _syncChargebackReputation(intentHash, intentRisk);
        }
        revert InvalidIntentRiskStatus(intentHash, intentRisk.status);
    }

    function _getReservedIntentRisk(bytes32 intentHash) internal view returns (IntentRisk storage intentRisk) {
        intentRisk = intentRisks[intentHash];
        if (intentRisk.status == IntentRiskStatus.None) revert IntentRiskNotFound(intentHash);
        if (intentRisk.status != IntentRiskStatus.Reserved) {
            revert InvalidIntentRiskStatus(intentHash, intentRisk.status);
        }
    }

    function _validateIntentOrchestrator(IntentRisk storage intentRisk) internal view {
        if (intentRisk.orchestrator != msg.sender) {
            revert IntentOrchestratorMismatch(msg.sender, intentRisk.orchestrator);
        }
    }

    function _calculateRiskAmount(uint256 amount, uint16 baseStakeBps, uint16 multiplierBps)
        internal
        pure
        returns (uint256)
    {
        uint256 baseAmount = Math.mulDiv(amount, baseStakeBps, BPS);
        return Math.mulDiv(baseAmount, multiplierBps, BPS);
    }

    function _syncAbandonmentReputation(bytes32 intentHash, IntentRisk storage intentRisk)
        internal
        returns (bool)
    {
        if (!intentRisk.abandonmentReputationRecorded) {
            try reputationRegistry.recordAbandonment(
                intentRisk.taker,
                intentRisk.signaledAmount,
                intentRisk.abandonmentExpired
            ) {
                intentRisk.abandonmentReputationRecorded = true;
            } catch (bytes memory reason) {
                emit ReputationUpdateFailed(intentHash, reason);
                return false;
            }
        }
        return _clearReputationHold(intentHash, intentRisk);
    }

    function _syncChargebackReputation(bytes32 intentHash, IntentRisk storage intentRisk)
        internal
        returns (bool)
    {
        uint256 targetAmount = intentRisk.cumulativeChargebackAmount;
        if (intentRisk.reputationChargebackAmount < targetAmount) {
            try reputationRegistry.recordChargeback(
                intentRisk.taker,
                intentRisk.reputationChargebackAmount,
                targetAmount
            ) {
                intentRisk.reputationChargebackAmount = targetAmount;
            } catch (bytes memory reason) {
                emit ReputationUpdateFailed(intentHash, reason);
                return false;
            }
        }
        return _clearReputationHold(intentHash, intentRisk);
    }

    function _clearReputationHold(bytes32 intentHash, IntentRisk storage intentRisk)
        internal
        returns (bool)
    {
        if (stakeVault.hasReputationHold(intentHash)) {
            try stakeVault.clearReputationHold(intentHash) {
                emit ReputationSynchronized(
                    intentHash,
                    intentRisk.reputationChargebackAmount,
                    intentRisk.abandonmentReputationRecorded
                );
            } catch (bytes memory reason) {
                emit ReputationUpdateFailed(intentHash, reason);
                return false;
            }
        }
        return true;
    }

    function _setDefaultTiers() internal {
        // Starter: permissionless bootstrap, full fee, 125% of configured platform stake.
        tierConfigs.push(TierConfig({ minReputation: 0, feeDiscountBps: 0, stakeMultiplierBps: 12_500 }));
        // Proven: consistent completion history.
        tierConfigs.push(TierConfig({ minReputation: 100, feeDiscountBps: 1_000, stakeMultiplierBps: 10_000 }));
        // Trusted: diverse, higher-weight graph participation.
        tierConfigs.push(TierConfig({ minReputation: 500, feeDiscountBps: 2_500, stakeMultiplierBps: 10_000 }));
        // Anchor: long-lived, highly connected protocol participant.
        tierConfigs.push(TierConfig({ minReputation: 2_000, feeDiscountBps: 4_000, stakeMultiplierBps: 10_000 }));
        emit TierConfigsUpdated(4);
    }
}
