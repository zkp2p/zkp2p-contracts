// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IStakeVault} from "./IStakeVault.sol";

interface IDisputeProtectionPolicyV2 {
    enum DisputeProtectionIntentStatus { NONE, SETTLED, RELEASED, DISPUTED }
    /// @dev Whitelisted takers settle in the hook without calling this policy or creating a record.
    enum CollateralSource { NONE, STAKE, DEFERRED_PAYOUT }

    struct DisputeProtectionIntent {
        address taker;            // intent.owner; may call claimFor on a deferred payout
        address recipient;        // intent.to; owns a deferred lock; the only claimFor payee
        address stakeOwner;       // lock owner: stakeOwnerOf(taker) for STAKE, recipient for DEFERRED_PAYOUT
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;
        DisputeProtectionIntentStatus status;
        CollateralSource collateralSource;
        uint64 releaseEligibleAt;
        uint256 lockedAmount;     // gross for STAKE, net for DEFERRED_PAYOUT
        uint256 claimedAmount;    // DEFERRED_PAYOUT only: total pushed by claimFor
    }

    /// @notice Emitted only for STAKE or DEFERRED_PAYOUT settlements.
    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DeferredPayoutClaimed(bytes32 indexed intentHash, address indexed recipient, address indexed caller, uint256 amount, uint256 totalClaimed);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
    error DisputeProtectionIntentAlreadyExists(bytes32 intentHash);
    error UnexpectedStatus(bytes32 intentHash, DisputeProtectionIntentStatus status);
    error DisputeProtectionIntentNotReleaseEligible(uint64 releaseEligibleAt, uint64 currentTime);
    error NotDeferredPayout(bytes32 intentHash);
    error UnauthorizedClaimer(address caller);
    error NothingToClaim(bytes32 intentHash);
    error InvalidSettlementAmount(uint256 releaseAmount, uint256 netAmount);
    error TimestampOverflow(uint256 timestamp);
    error InvalidRiskWindow(uint64 riskWindow);
    error OwnershipRenunciationDisabled();

    struct SettleParams {
        bytes32 intentHash;
        address taker;
        address recipient;
        address depositor;
        address token;
        bytes32 paymentMethod;
        uint256 releaseAmount;
        uint256 netAmount;
        uint64 riskWindow;
    }

    /// @notice Records a protected settlement, selects collateral, and returns whether payout funding is required.
    /// @dev Uses the depositor and token captured before escrow unlock; never reads escrow. Non-stake tokens
    /// and zero windows return false with no record or event. Protected records store the attested window's
    /// releaseEligibleAt; the window and gross release amount are preserved only in the settlement event.
    /// The hook handles manual releases, zero windows and live whitelisted takers without any policy call or event.
    /// Deferred records are SETTLED immediately and return true. OrchestratorV4 calls the hook's
    /// onDeferredPayoutFunded in the same transaction right after settleIntent and transferring the net payout.
    /// A caller that skips funding leaves a SETTLED deferred record without a vault lock.
    function onIntentSettled(SettleParams calldata _params) external returns (bool deferred);
    /// @notice Accounts for a deferred payout transferred to the vault.
    /// @dev Requires a SETTLED DEFERRED_PAYOUT record. The hook forwards OrchestratorV4's callback in the same
    /// transaction right after settleIntent and the net transfer. Skipping it leaves the SETTLED record without
    /// a vault lock. The vault rejects duplicate funding with LockAlreadyExists; the policy record is unchanged.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;
    /// @notice Returns whether a lifecycle hook may create and fund settlement records.
    function isLifecycleHookAuthorized(address _hook) external view returns (bool);
    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVault);
}
