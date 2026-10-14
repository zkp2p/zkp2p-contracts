// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IStakeVault} from "./IStakeVault.sol";

interface ICascadeDisputeProtectionPolicy {
    enum DisputeProtectionIntentStatus { NONE, PENDING, CANCELLED, AWAITING_FUNDING, SETTLED, RELEASED, DISPUTED }
    enum OptOutState { INHERIT, ENABLED, DISABLED }
    enum CollateralSource { NONE, BYPASS, STAKE, DEFERRED_PAYOUT, MANUAL_RELEASE }

    struct DisputeProtectionIntent {
        address taker;            // intent.owner; may call claimFor on a deferred payout
        address recipient;        // intent.to; owns a deferred lock; the only claimFor payee
        address stakeOwner;       // lock owner: stakeOwnerOf(taker) for STAKE, recipient for DEFERRED_PAYOUT
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;
        DisputeProtectionIntentStatus status;
        CollateralSource collateralSource;
        uint64 riskWindow;        // snapshotted at signal
        uint64 releaseEligibleAt;
        uint256 releaseAmount;    // gross amount released from Escrow
        uint256 lockedAmount;     // gross for STAKE, net for DEFERRED_PAYOUT, 0 for BYPASS
        uint256 claimedAmount;    // DEFERRED_PAYOUT only: total pushed by claimFor
    }

    event DisputeProtectionIntentOpened(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow);
    event DisputeProtectionIntentCancelled(bytes32 indexed intentHash);
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, CollateralSource indexed collateralSource, address indexed stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt, bool isManualRelease);
    event DeferredPayoutFunded(bytes32 indexed intentHash, address indexed recipient, uint256 amount, uint64 releaseEligibleAt);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DeferredPayoutClaimed(bytes32 indexed intentHash, address indexed recipient, address indexed caller, uint256 amount, uint256 totalClaimed);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event DisputeProtectionEnabledUpdated(address indexed escrow, uint256 indexed depositId, bytes32 indexed paymentMethod, bool isDisputeProtectionEnabled);
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);
    event AdmissionsPausedUpdated(bool isPaused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    error AdmissionsPaused();
    error DisputeProtectionNotEnabled(address escrow, uint256 depositId, bytes32 paymentMethod);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error UnexpectedStatus(bytes32 intentHash, DisputeProtectionIntentStatus status);
    error IntentTokenMismatch(address expectedToken, address actualToken);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error NotDeferredPayout(bytes32 intentHash);
    error UnauthorizedClaimer(address caller);
    error NothingToClaim(bytes32 intentHash);
    error InvalidSettlementAmount(uint256 releaseAmount, uint256 netAmount);
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error NotDepositor(address escrow, uint256 depositId, address caller);
    error OwnershipRenunciationDisabled();

    /// @notice Records admission without locking collateral.
    function onIntentSignaled(bytes32 _intentHash, address _escrow, uint256 _depositId, address _taker, address _recipient, bytes32 _paymentMethod) external;
    /// @notice Cancels a pending admission.
    function onIntentCancelled(bytes32 _intentHash) external;
    /// @notice Selects settlement collateral and returns whether payout funding is required.
    function onIntentSettled(bytes32 _intentHash, uint256 _releaseAmount, uint256 _netAmount, bool _balanceFunded, bool _isManualRelease) external returns (bool deferred);
    /// @notice Accounts for a deferred payout transferred to the vault.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;
    /// @notice Returns effective deposit and payment method protection.
    function isDisputeProtectionEnabled(address _escrow, uint256 _depositId, bytes32 _paymentMethod) external view returns (bool);
    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVault);
}
