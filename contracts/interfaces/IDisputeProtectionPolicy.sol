// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDisputeProtectionPolicy
 * @notice Lifecycle-hook integration surface for stake-backed dispute coverage.
 * @dev The concrete policy exposes depositor, governance, dispute, and release functions directly.
 *      This interface intentionally contains only the functions consumed by IntentLifecycleHookV1.
 */
interface IDisputeProtectionPolicy {
    /**
     * @notice Lifecycle state of a dispute-protected intent.
     * @dev `NONE` is the required zero-value sentinel for an uninitialized mapping entry; it is not a live state.
     *      `SETTLED` means the underlying intent completed and its collateral remains disputable.
     *      `RELEASED` means the collateral was returned and the intent is no longer disputable.
     */
    enum DisputeProtectionIntentStatus {
        NONE,
        PENDING,
        CANCELLED,
        SETTLED,
        RELEASED,
        DISPUTED
    }

    /**
     * @notice Dispute protection state retained after an intent is admitted by the lifecycle hook.
     * @param taker Account that signaled the intent.
     * @param stakeOwner Account whose StakeVault balance collateralizes the intent.
     * @param depositor Escrow depositor compensated by a successful dispute.
     * @param paymentMethod Payment method used to namespace risk configuration and dispute nullifiers.
     * @param status Current dispute protection lifecycle state.
     * @param riskWindow Minimum time collateral must remain locked after intent settlement.
     * @param releaseEligibleAt Earliest timestamp at which collateral may be released. Dispute evidence remains
     * valid after this time until release actually executes.
     * @param releaseAmount Amount released from Escrow before fees and therefore collateralized after settlement.
     */
    struct DisputeProtectionIntent {
        address taker;
        address stakeOwner;
        address depositor;
        bytes32 paymentMethod;
        DisputeProtectionIntentStatus status;
        uint64 riskWindow;
        uint64 releaseEligibleAt;
        uint256 releaseAmount;
    }

    event DisputeProtectionIntentOpened(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        address taker,
        bytes32 paymentMethod,
        uint256 amount,
        uint64 riskWindow
    );
    event DisputeProtectionIntentCancelled(
        bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount
    );
    event DisputeProtectionIntentSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 releaseAmount,
        uint64 releaseEligibleAt,
        bool isManualRelease
    );
    event DisputeProtectionIntentReleased(
        bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount
    );
    event DisputeResolved(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 compensatedAmount,
        bytes32 disputeId
    );
    event DisputeProtectionEnabledUpdated(
        address indexed escrow, uint256 indexed depositId, bool isDisputeProtectionEnabled
    );
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);
    event AdmissionsPausedUpdated(bool isPaused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    error AdmissionsPaused();
    error DisputeProtectionNotEnabled(address escrow, uint256 depositId);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error DisputeProtectionIntentNotPending(bytes32 intentHash, DisputeProtectionIntentStatus status);
    error DisputeProtectionIntentNotSettled(bytes32 intentHash, DisputeProtectionIntentStatus status);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error OwnershipRenunciationDisabled();

    /**
     * @notice Admits a newly signaled intent into dispute coverage when its payment method has a risk window.
     * @dev Called only by an authorized lifecycle hook. A zero configured risk window is an unrestricted pass-through
     * and creates no dispute protection intent. Otherwise the call validates deposit configuration and token
     * compatibility, snapshots the risk configuration, and locks the taker's selected stake.
     * @param _intentHash Unique intent identifier assigned by the calling orchestrator.
     * @param _escrow Escrow that owns the intent and deposit.
     * @param _depositId Deposit supplying the intent liquidity.
     * @param _taker Account that signaled the intent.
     * @param _paymentMethod Payment method selected for the off-chain payment.
     * @param _amount Full on-chain intent amount initially locked as collateral.
     */
    function onIntentSignaled(
        bytes32 _intentHash,
        address _escrow,
        uint256 _depositId,
        address _taker,
        bytes32 _paymentMethod,
        uint256 _amount
    ) external;

    /**
     * @notice Cancels a pending dispute protection intent and unlocks its collateral.
     * @dev Missing dispute protection intents are ignored because payment methods with no risk window create no
     * policy state.
     * @param _intentHash Intent being cancelled or pruned by the orchestrator.
     */
    function onIntentCancelled(bytes32 _intentHash) external;

    /**
     * @notice Marks a pending dispute protection intent as settled and resizes its collateral.
     * @dev Missing dispute protection intents are ignored. The snapshotted risk window determines when collateral
     * becomes release-eligible; it does not invalidate dispute evidence until release actually executes.
     * @param _intentHash Intent completed by proof-based fulfillment or manual release.
     * @param _releaseAmount Amount released from Escrow before protocol, referral, and manager fees.
     * @param _isManualRelease Whether the depositor used the manual-release path without an on-chain payment proof.
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease) external;

    /**
     * @notice Returns whether a deposit opted into stake-backed dispute protection.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose dispute protection configuration is queried.
     */
    function isDisputeProtectionEnabled(address _escrow, uint256 _depositId) external view returns (bool);
}
