// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDisputePolicy
 * @notice Lifecycle-hook integration surface for stake-backed dispute coverage.
 * @dev The concrete policy exposes depositor, governance, dispute, and release functions directly.
 *      This interface intentionally contains only the functions consumed by IntentLifecycleHookV1.
 */
interface IDisputePolicy {
    /**
     * @notice Lifecycle state of a dispute-enabled intent.
     * @dev `NONE` is the required zero-value sentinel for an uninitialized mapping entry; it is not a live state.
     *      `SETTLED` means the underlying intent completed and its collateral remains disputable.
     *      `RELEASED` means the collateral was returned and the intent is no longer disputable.
     */
    enum DisputeIntentStatus {
        NONE,
        PENDING,
        CANCELLED,
        SETTLED,
        RELEASED,
        DISPUTED
    }

    /**
     * @notice Dispute state retained after an intent is admitted by the lifecycle hook.
     * @param taker Account that signaled the intent.
     * @param stakeOwner Account whose StakeVault balance collateralizes the intent.
     * @param depositor Escrow depositor compensated by a successful dispute.
     * @param paymentMethod Payment method used to namespace risk configuration and dispute nullifiers.
     * @param status Current dispute lifecycle state.
     * @param riskWindow Minimum time collateral must remain locked after intent settlement.
     * @param releaseEligibleAt Earliest timestamp at which collateral may be released. Dispute evidence remains
     * valid after this time until release actually executes.
     * @param intentAmount Original settlement-token-denominated intent exposure.
     * @param collateralAmount ERC-4626 share amount currently locked for the intent.
     * @param releaseAmount Amount released from Escrow before fees and therefore collateralized after settlement.
     */
    struct DisputeIntent {
        address taker;
        address stakeOwner;
        address depositor;
        bytes32 paymentMethod;
        DisputeIntentStatus status;
        uint64 riskWindow;
        uint64 releaseEligibleAt;
        uint256 intentAmount;
        uint256 collateralAmount;
        uint256 releaseAmount;
    }

    event DisputeIntentOpened(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        address taker,
        bytes32 paymentMethod,
        uint256 intentAmount,
        uint256 collateralAmount,
        uint64 riskWindow
    );
    event DisputeIntentCancelled(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DisputeIntentSettled(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 releaseAmount,
        uint256 collateralAmount,
        uint64 releaseEligibleAt,
        bool isManualRelease
    );
    event DisputeIntentReleased(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DisputeResolved(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 compensatedSettlementAmount,
        uint256 compensatedCollateralAmount,
        bool collateralCapped,
        bytes32 disputeId
    );
    event DisputeEnabledUpdated(address indexed escrow, uint256 indexed depositId, bool isDisputeEnabled);
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);
    event AdmissionsPausedUpdated(bool isPaused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    error AdmissionsPaused();
    error DisputeNotEnabled(address escrow, uint256 depositId);
    error DisputeIntentAlreadyExists(bytes32 intentHash);
    error DisputeIntentNotPending(bytes32 intentHash, DisputeIntentStatus status);
    error DisputeIntentNotSettled(bytes32 intentHash, DisputeIntentStatus status);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error CollateralAssetMismatch(address expectedAsset, address actualAsset);
    error StakeTokenMismatch(address expectedToken, address actualToken);
    error CollateralConversionUnavailable();
    error ReleaseAmountExceedsIntent(uint256 intentAmount, uint256 releaseAmount);
    error DisputeIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error OwnershipRenunciationDisabled();

    /**
     * @notice Admits a newly signaled intent into dispute coverage when its payment method has a risk window.
     * @dev Called only by an authorized lifecycle hook. A zero configured risk window is an unrestricted pass-through
     * and creates no dispute intent. Otherwise the call validates deposit configuration and token compatibility,
     * snapshots the risk configuration, and locks the taker's selected stake.
     * @param _intentHash Unique intent identifier assigned by the calling orchestrator.
     * @param _escrow Escrow that owns the intent and deposit.
     * @param _depositId Deposit supplying the intent liquidity.
     * @param _taker Account that signaled the intent.
     * @param _paymentMethod Payment method selected for the off-chain payment.
     * @param _amount Full settlement-token-denominated intent amount converted into collateral shares.
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
     * @notice Cancels a pending dispute intent and unlocks its collateral.
     * @dev Missing dispute intents are ignored because payment methods with no risk window create no policy state.
     * @param _intentHash Intent being cancelled or pruned by the orchestrator.
     */
    function onIntentCancelled(bytes32 _intentHash) external;

    /**
     * @notice Marks a pending dispute intent as settled and resizes its collateral to the actual release amount.
     * @dev Missing dispute intents are ignored. The snapshotted risk window determines when collateral becomes
     * release-eligible; it does not invalidate dispute evidence until release actually executes.
     * @param _intentHash Intent completed by proof-based fulfillment or manual release.
     * @param _releaseAmount Amount released from Escrow before protocol, referral, and manager fees.
     * @param _isManualRelease Whether the depositor used the manual-release path without an on-chain payment proof.
     */
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease) external;

    /**
     * @notice Returns whether a deposit opted into stake-backed dispute admission.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose dispute configuration is queried.
     */
    function isDisputeEnabled(address _escrow, uint256 _depositId) external view returns (bool);
}
