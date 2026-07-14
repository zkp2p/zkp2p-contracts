// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IIntentRiskHook } from "./IIntentRiskHook.sol";
import { IOrchestratorV3 } from "./IOrchestratorV3.sol";

/**
 * @title IRiskTierManager
 * @notice Policy interface for stake-derived taker tiers and chargeback positions.
 */
interface IRiskTierManager is IIntentRiskHook {
    /* ============ Enums ============ */

    enum Tier {
        PEASANT,
        PEER,
        PLUS,
        PRO,
        PLATINUM
    }

    enum RiskMode {
        NONE,
        STAKE_BACKED,
        DEFERRED_PAYOUT
    }

    enum PositionStatus {
        NONE,
        ACTIVE,
        CANCELLED,
        RELEASED,
        SLASHED
    }

    /* ============ Structs ============ */

    struct PlatformRiskConfig {
        bool enabled;
        bool chargebackable;
        bool deferredPayoutEnabled;
        uint16 reserveBps;
        uint64 riskWindow;
        uint256[5] tierCaps;
    }

    struct RiskPosition {
        address taker;
        address stakeOwner;
        address maker;
        bytes32 paymentMethod;
        RiskMode mode;
        PositionStatus status;
        bool countsTowardConcurrency;
        address deferredPayoutHook;
        address payoutRecipient;
        uint16 reserveBps;
        uint64 riskWindow;
        uint64 settlementBuffer;
        uint64 settledAt;
        uint64 slashDeadline;
        uint64 releaseTime;
        uint256 reservedAmount;
        uint256 releasedAmount;
        uint256 slashedAmount;
    }

    struct ChargebackAttestation {
        uint256 chainId;
        address riskTierManager;
        address orchestrator;
        bytes32 intentHash;
        bytes32 paymentMethod;
        uint256 chargebackAmount;
        bytes32 evidenceId;
        uint256 nonce;
        uint64 validAfter;
        uint64 validUntil;
    }

    /* ============ Events ============ */

    event TierThresholdsUpdated(uint256 peer, uint256 plus, uint256 pro, uint256 platinum);
    event ConcurrencyLimitsUpdated(uint256 peasant, uint256 peer, uint256 plus, uint256 pro, uint256 platinum);
    event PlatformRiskConfigUpdated(
        bytes32 indexed paymentMethod,
        bool enabled,
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint16 reserveBps,
        uint64 riskWindow,
        uint256 peasantCap,
        uint256 peerCap,
        uint256 plusCap,
        uint256 proCap,
        uint256 platinumCap
    );
    event RiskPositionCreated(
        bytes32 indexed intentHash,
        address indexed taker,
        address indexed maker,
        address stakeOwner,
        bytes32 paymentMethod,
        RiskMode mode,
        address deferredPayoutHook,
        address payoutRecipient,
        uint256 reservedAmount,
        uint64 settlementBuffer,
        uint64 fallbackReleaseTime
    );
    event RiskPositionCancelled(bytes32 indexed intentHash, address indexed taker, uint256 releasedReservation);
    event RiskPositionFulfilled(
        bytes32 indexed intentHash,
        address indexed taker,
        RiskMode mode,
        uint256 releasedAmount,
        uint256 reservedAmount,
        uint64 settledAt,
        uint64 slashDeadline,
        uint64 releaseTime
    );
    event DeferredPayoutRegistered(
        bytes32 indexed intentHash,
        address indexed beneficiary,
        uint256 amount,
        uint64 releaseTime
    );
    event RiskPositionReleased(bytes32 indexed intentHash, address indexed taker, RiskMode mode, uint256 releasedAmount);
    event ChargebackSettled(
        bytes32 indexed intentHash,
        address indexed taker,
        address indexed maker,
        RiskMode mode,
        uint256 attestedAmount,
        uint256 slashedAmount,
        uint256 totalSlashed,
        uint256 remainingCoverage,
        bytes32 evidenceId
    );
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event DeferredPayoutHookUpdated(address indexed previousHook, address indexed newHook);
    event TimingConfigUpdated(uint64 maxIntentLifetime, uint64 settlementBuffer);
    event AdmissionPausedUpdated(bool paused);

    /* ============ Governance Functions ============ */

    function setTierThresholds(uint256[4] calldata _thresholds) external;
    function setConcurrencyLimits(uint256[5] calldata _limits) external;
    function setPlatformRiskConfig(bytes32 _paymentMethod, PlatformRiskConfig calldata _config) external;
    function setAttestationVerifier(address _verifier) external;
    function setDeferredPayoutHook(address _hook) external;
    function setTimingConfig(uint64 _maxIntentLifetime, uint64 _settlementBuffer) external;
    function setAdmissionPaused(bool _paused) external;
    function acceptVaultController() external;

    /* ============ Lifecycle Functions ============ */

    function registerDeferredPayout(bytes32 _intentHash, address _beneficiary, uint256 _amount) external;
    function reconcileSettlement(bytes32 _intentHash) external;
    function reconcileSettlements(bytes32[] calldata _intentHashes) external;
    function releaseMaturedPosition(bytes32 _intentHash) external;
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;
    function submitChargeback(
        ChargebackAttestation calldata _attestation,
        bytes[] calldata _signatures,
        bytes calldata _verificationData
    ) external;

    /* ============ View Functions ============ */

    function getTier(address _taker) external view returns (Tier);
    function getTierForStake(uint256 _stake) external view returns (Tier);
    function activeIntentCount(address _stakeOwner) external view returns (uint256);
    function getPlatformRiskConfig(bytes32 _paymentMethod) external view returns (PlatformRiskConfig memory);
    function getRiskPosition(bytes32 _intentHash) external view returns (RiskPosition memory);
    /**
     * @notice Returns resolved stake-owner state and its shared count of unsettled intents.
     * @dev Settled positions still inside a chargeback window are collateral-bounded and excluded from activeIntents.
     */
    function getTakerState(address _taker)
        external
        view
        returns (Tier tier, uint256 totalStake, uint256 reserved, uint256 free, bool exiting, uint256 activeIntents);
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation) external view returns (bytes32);
    function orchestrator() external view returns (IOrchestratorV3);
}
