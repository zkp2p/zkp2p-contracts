// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IStakeVault} from "./IStakeVault.sol";

interface IDisputeProtectionPolicyV2 {
    enum DisputeProtectionIntentStatus { NONE, AWAITING_FUNDING, SETTLED, RELEASED, DISPUTED }
    /// @dev BYPASS covers balance-funded payments or takers allowed by an enabled deposit/payment-method whitelist.
    enum CollateralSource { NONE, BYPASS, STAKE, DEFERRED_PAYOUT, MANUAL_RELEASE }

    struct DisputeProtectionIntent {
        address taker;            // intent.owner; may call claimFor on a deferred payout
        address recipient;        // intent.to; owns a deferred lock; the only claimFor payee
        address stakeOwner;       // lock owner: stakeOwnerOf(taker) for STAKE, recipient for DEFERRED_PAYOUT
        address depositor;        // paid on a proven dispute
        bytes32 paymentMethod;
        DisputeProtectionIntentStatus status;
        CollateralSource collateralSource;
        uint64 riskWindow;        // snapshotted at settlement
        uint64 releaseEligibleAt;
        uint256 releaseAmount;    // gross amount released from Escrow
        uint256 lockedAmount;     // gross for STAKE, net for DEFERRED_PAYOUT, 0 for BYPASS
        uint256 claimedAmount;    // DEFERRED_PAYOUT only: total pushed by claimFor
    }

    event DisputeProtectionIntentSettled(bytes32 indexed intentHash, address indexed taker, address indexed depositor, address recipient, bytes32 paymentMethod, uint64 riskWindow, CollateralSource collateralSource, address stakeOwner, uint256 releaseAmount, uint256 lockedAmount, uint64 releaseEligibleAt, bool isManualRelease);
    event DeferredPayoutFunded(bytes32 indexed intentHash, address indexed recipient, uint256 amount, uint64 releaseEligibleAt);
    event DisputeProtectionIntentReleased(bytes32 indexed intentHash, address indexed stakeOwner, uint256 releasedAmount);
    event DeferredPayoutClaimed(bytes32 indexed intentHash, address indexed recipient, address indexed caller, uint256 amount, uint256 totalClaimed);
    event DisputeResolved(bytes32 indexed intentHash, address indexed stakeOwner, address indexed depositor, uint256 compensatedAmount, bytes32 disputeId);
    event RiskWindowUpdated(bytes32 indexed paymentMethod, uint64 riskWindow);
    event DisputeVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event LifecycleHookAuthorizationUpdated(address indexed hook, bool isAuthorized);
    event AdmissionsPausedUpdated(bool isPaused);

    error ZeroAddress();
    error InvalidContract(address dependency);
    error UnauthorizedLifecycleHook(address caller);
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
        /// @dev Balance-funded payment or taker allowed by an enabled deposit/payment-method whitelist.
        /// Relayer registration alone does not qualify. The hook checks live settlement state;
        /// manual release takes precedence over bypass.
        bool bypass;
        bool isManualRelease;
    }

    /// @notice Records a protected settlement, selects collateral, and returns whether payout funding is required.
    /// @dev Uses the depositor and token captured by the orchestrator before escrow unlock; never reads escrow.
    function onIntentSettled(SettleParams calldata _params) external returns (bool deferred);
    /// @notice Accounts for a deferred payout transferred to the vault.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;
    /// @notice Returns the risk window used by future settlements; zero disables protection for the method.
    function getRiskWindow(bytes32 _paymentMethod) external view returns (uint64);
    /// @notice Returns whether a lifecycle hook may create and fund settlement records.
    function isLifecycleHookAuthorized(address _hook) external view returns (bool);
    /// @notice Returns whether new protected signals are paused; settlement remains available.
    function admissionsPaused() external view returns (bool);
    /// @notice Returns the collateral vault.
    function stakeVault() external view returns (IStakeVault);
}
