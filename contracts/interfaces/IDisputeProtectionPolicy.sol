// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IDisputeProtectionPolicy
 * @notice Lifecycle-hook integration surface for payment policies and collateral coverage.
 * @dev The concrete policy exposes depositor, governance, dispute, and release functions directly.
 *      This interface intentionally contains only the functions consumed by IntentLifecycleHookV1.
 */
interface IDisputeProtectionPolicy {
    /**
     * @notice Lifecycle state of a dispute-protected intent.
     * @dev `NONE` is the required zero-value sentinel for an uninitialized mapping entry; it is not a live state.
     *      `SETTLED` means the underlying intent completed. Collateral remains disputable only with a positive
     *      snapshotted risk window; zero-window intents have no collateral coverage.
     *      `RELEASED` means the collateral was returned and the intent is no longer disputable.
     */
    enum PolicyIntentStatus {
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
     * @param stakeOwner Account whose StakeVault balance collateralizes the intent; zero for zero-window admission.
     * @param depositor Escrow depositor compensated by a successful dispute.
     * @param lifecycleHook Authorized hook that admitted the intent and must deliver terminal callbacks.
     * @param orchestrator Authenticated originating orchestrator that owns the intent.
     * @param policyId Effective evidence policy, updated only by an authorized pending-order correction.
     * @param paymentMethod Payment method used to namespace risk configuration and dispute nullifiers.
     * @param status Current dispute protection lifecycle state.
     * @param riskWindow Minimum time collateral must remain locked after settlement; zero for an admitted zero-window policy.
     * @param releaseEligibleAt Earliest timestamp at which collateral may be released. Dispute evidence remains
     * valid after this time until release actually executes.
     * @param releaseAmount Amount released from Escrow before fees and therefore collateralized after settlement.
     */
    struct PolicyIntent {
        address taker;
        uint64 riskWindow;
        PolicyIntentStatus status;
        address stakeOwner;
        uint64 releaseEligibleAt;
        address depositor;
        address lifecycleHook;
        address orchestrator;
        bytes32 paymentMethod;
        bytes32 policyId;
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
    event PolicyAdmissionEnabledUpdated(
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 indexed paymentMethod,
        bool isPolicyAdmissionEnabled
    );
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);
    event AdmissionsPausedUpdated(bool isPaused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    error AdmissionsPaused();
    error PolicyAdmissionDisabled(address escrow, uint256 depositId, bytes32 paymentMethod);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error DisputeProtectionIntentNotPending(bytes32 intentHash, PolicyIntentStatus status);
    error DisputeProtectionIntentNotSettled(bytes32 intentHash, PolicyIntentStatus status);
    error DisputeProtectionIntentNotCovered(bytes32 intentHash);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error OwnershipRenunciationDisabled();

    /// @notice Canonical admission context supplied by an authorized hook after authenticating its caller.
    struct AdmissionContext {
        bytes32 intentHash;
        address orchestrator;
        address escrow;
        uint256 depositId;
        address taker;
        bytes32 paymentMethod;
        uint256 amount;
        bytes32 policyId;
        bool whitelistEnabled;
    }

    /// @notice Snapshots policy terms and locks collateral for an authenticated admission.
    /// @param _context Intent fields, originating orchestrator, selected policy and whitelist admission result.
    function onIntentSignaled(AdmissionContext calldata _context) external;

    /**
     * @notice Cancels a pending intent and unlocks its collateral when it has protection.
     * @dev Missing records are ignored for whitelist/open admissions. An admitted zero-window policy still has
     * lifecycle state, but no collateral to unlock.
     * @param _orchestrator Authenticated lifecycle caller forwarded by the hook.
     * @param _intentHash Intent being cancelled or pruned by the orchestrator.
     */
    function onIntentCancelled(address _orchestrator, bytes32 _intentHash) external;

    /**
     * @notice Marks a pending intent as settled and resizes collateral only when it has protection.
     * @dev Missing dispute protection intents are ignored. The snapshotted risk window determines when collateral
     * becomes release-eligible; it does not invalidate dispute evidence until release actually executes.
     * @param _orchestrator Authenticated lifecycle caller forwarded by the hook.
     * @param _intentHash Intent completed by proof-based fulfillment or manual release.
     * @param _releaseAmount Amount released from Escrow before protocol, referral, and manager fees.
     * @param _isManualRelease Whether the depositor used the manual-release path without an on-chain payment proof.
     */
    function onIntentSettled(address _orchestrator, bytes32 _intentHash, uint256 _releaseAmount, bool _isManualRelease) external;

    /**
     * @notice Returns whether a deposit payment method routes through policy admission.
     * @dev True when the depositor has not opted the tuple out and the method's default rule is registered.
     * Performs no validation: any escrow, any deposit id (including nonexistent ones), and any payment method with a
     * registered default rule read true. The selected rule must separately be enabled at admission.
     * @param _escrow Escrow containing the deposit.
     * @param _depositId Deposit whose payment-method-specific configuration is queried.
     * @param _paymentMethod Payment method whose dispute protection configuration is queried.
     */
    function isPolicyAdmissionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod)
        external
        view
        returns (bool);
}
