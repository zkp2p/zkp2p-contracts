// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAttestationVerifier} from "./IAttestationVerifier.sol";
import {IEscrowRegistry} from "./IEscrowRegistry.sol";
import {INullifierRegistryV2} from "./INullifierRegistryV2.sol";
import {IStakeVault} from "./IStakeVault.sol";

/**
 * @title IChargebackPolicy
 * @notice Deposit-scoped, stake-backed chargeback policy used by an intent lifecycle hook.
 * Payment methods without a risk window pass through with direct access and no chargeback position.
 */
interface IChargebackPolicy {
    enum PositionStatus {
        NONE,
        PENDING,
        CANCELLED,
        SETTLED,
        RELEASED,
        SLASHED
    }

    struct Position {
        address taker;
        address stakeOwner;
        address depositor;
        bytes32 paymentMethod;
        PositionStatus status;
        bool isManualRelease;
        uint64 riskWindow;
        uint64 coverageDeadline;
        uint256 intentAmount;
        uint256 coverageAmount;
        uint256 grossReleasedAmount;
    }

    struct ChargebackAttestation {
        bytes32 intentHash;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
    }

    struct ChargebackDetails {
        bytes32 paymentMethod;
        bytes32 originalPaymentId;
        bytes32 disputeId;
        uint256 paymentAmount;
        bytes32 paymentCurrency;
    }

    event PositionOpened(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        address taker,
        bytes32 paymentMethod,
        uint256 amount,
        uint64 riskWindow
    );
    event PositionCancelled(
        bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedCoverage
    );
    event PositionSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 grossAmount,
        uint64 coverageDeadline,
        bool isManualRelease
    );
    event PositionReleased(
        bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedCoverage
    );
    event ChargebackSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 compensatedAmount,
        bytes32 disputeId
    );
    event EnabledUpdated(address indexed escrow, uint256 indexed depositId, bool enabled);
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookUpdated(address indexed previousHook, address indexed newHook);
    /** @notice Emitted when a lifecycle hook's callback authorization changes. */
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool authorized);
    event EscrowRegistryUpdated(address indexed escrowRegistry);
    event AdmissionsPausedUpdated(bool paused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    /** @notice Reverts when attempting to revoke the currently designated lifecycle hook. */
    error CannotRevokeCurrentLifecycleHook(address hook);
    /** @notice Reverts when attempting to revoke a lifecycle hook that is not authorized. */
    error LifecycleHookNotAuthorized(address hook);
    error AdmissionsPaused();
    error ChargebackNotEnabled(address escrow, uint256 depositId);
    error InsufficientCollateral(address stakeOwner, uint256 available, uint256 required);
    error PositionAlreadyExists(bytes32 intentHash);
    error PositionNotPending(bytes32 intentHash, PositionStatus status);
    error PositionNotSettled(bytes32 intentHash, PositionStatus status);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error PositionNotMature(uint64 coverageDeadline, uint64 currentTime);
    error InvalidAttestation();
    error InvalidPaymentBinding(bytes32 intentHash, bytes32 nullifier);
    error ChargebackWindowClosed(uint64 coverageDeadline, uint64 currentTime);
    error ChargebackEvidenceUsed(bytes32 nullifier);
    error IncompleteChargebackCoverage(uint256 available, uint256 required);
    error AttestationVerificationFailed();
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error EscrowNotWhitelisted(address escrow);
    error DepositNotFound(address escrow, uint256 depositId);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error OwnershipRenunciationDisabled();

    /**
     * @notice Opens stake-backed coverage for a chargeback-enabled intent.
     * @dev A zero risk window passes through before paused, enabled, or duplicate checks because a
     * non-chargebackable method uses direct access and pass-through is not an admission.
     */
    function admitIntent(
        bytes32 _intentHash,
        address _escrow,
        uint256 _depositId,
        address _taker,
        bytes32 _paymentMethod,
        uint256 _amount
    ) external;
    /** @notice Cancels pending coverage, or silently ignores an intent with no position. */
    function onIntentCancelled(bytes32 _intentHash) external;

    /** @notice Transitions pending coverage into its post-settlement risk window. */
    function onIntentSettled(bytes32 _intentHash, uint256 _grossAmount, bool _isManualRelease) external;

    /** @notice Releases one settled position at or after its coverage deadline. */
    function releaseMaturedPosition(bytes32 _intentHash) external;

    /** @notice Releases a batch of settled positions at or after their coverage deadlines. */
    function releaseMaturedPositions(bytes32[] calldata _intentHashes) external;

    /** @notice Resolves valid chargeback evidence into an immediately claimable depositor award. */
    function submitChargeback(ChargebackAttestation calldata _attestation) external;

    /** @notice Enables or disables chargeback admission for a deposit. */
    function setEnabled(address _escrow, uint256 _depositId, bool _enabled) external;

    /** @notice Sets the coverage window snapshotted by future intents for a payment method. */
    function setRiskWindow(bytes32 _paymentMethod, uint64 _riskWindow) external;

    /** @notice Replaces the verifier used for future chargeback submissions. */
    function setAttestationVerifier(address _verifier) external;

    /** @notice Designates and authorizes the current hook without deauthorizing predecessor hooks. */
    function setLifecycleHook(address _hook) external;

    /** @notice Revokes a predecessor hook after all intents snapshotted to it have been drained. */
    function revokeLifecycleHook(address _hook) external;

    /** @notice Replaces the registry used to authorize deposit configuration. */
    function setEscrowRegistry(IEscrowRegistry _escrowRegistry) external;

    /** @notice Pauses or resumes new admissions without blocking terminal transitions. */
    function setAdmissionsPaused(bool _paused) external;

    /** @notice Accepts this policy as the StakeVault controller after a delayed handover. */
    function acceptVaultController() external;

    /** @notice Always reverts so governed safety controls cannot become unreachable. */
    function renounceOwnership() external;

    /** @notice Returns the stored chargeback position for an intent. */
    function getPosition(bytes32 _intentHash) external view returns (Position memory);

    /** @notice Returns the EIP-712 digest signed for a chargeback attestation. */
    function hashChargebackAttestation(ChargebackAttestation calldata _attestation)
        external
        view
        returns (bytes32);

    /** @notice Returns the live selected stake owner and that owner's vault balances. */
    function getTakerState(address _taker)
        external
        view
        returns (address stakeOwner, uint256 totalStake, uint256 lockedStake, uint256 freeStake);

    /** @notice Returns the policy's stake custody and accounting dependency. */
    function stakeVault() external view returns (IStakeVault);

    /** @notice Returns the canonical payment-nullifier binding registry. */
    function nullifierRegistry() external view returns (INullifierRegistryV2);

    /** @notice Returns the verifier used for chargeback attestations. */
    function attestationVerifier() external view returns (IAttestationVerifier);

    /** @notice Returns the registry used to authorize escrow deposit configuration. */
    function escrowRegistry() external view returns (IEscrowRegistry);

    /** @notice Returns the currently designated lifecycle hook for new intent routing. */
    function lifecycleHook() external view returns (address);

    /** @notice Returns whether a lifecycle hook is authorized to mutate positions. */
    function authorizedLifecycleHooks(address _hook) external view returns (bool);

    /** @notice Returns whether new chargeback admissions are paused. */
    function admissionsPaused() external view returns (bool);

    /** @notice Returns whether chargeback admission is enabled for a deposit. */
    function enabled(address _escrow, uint256 _depositId) external view returns (bool);

    /** @notice Returns the future-admission risk window for a payment method. */
    function riskWindows(bytes32 _paymentMethod) external view returns (uint64);

    /** @notice Returns whether a payment-method-scoped dispute identifier has been consumed. */
    function usedChargebackNullifiers(bytes32 _nullifier) external view returns (bool);
}
