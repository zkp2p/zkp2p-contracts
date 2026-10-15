// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Minimal settlement boundary used by OrchestratorV4.
/// @dev O4 depends only on these two functions. A replacement policy needs to implement only this
/// settlement interface (and advertise it through ERC-165), so settlement rules can change without
/// deploying another orchestrator. Each intent retains the policy snapshotted at signal.
interface IIntentSettlementPolicy {
    struct SettlementContext {
        bytes32 intentHash;
        address token;
        address taker;
        address recipient;
        address depositor; // Captured before escrow unlock can delete the deposit.
        address escrow;
        uint256 depositId;
        bytes32 paymentMethod;
        uint256 releaseAmount;
        uint256 netAmount;
        bytes data;
        bytes extensionData;
        bool isManualRelease;
    }

    /// @notice Validates signed conditions and selects immediate or deferred settlement.
    /// @dev Signed extension words: 0 = dispute window (uint256 seconds), required for non-manual
    /// settlements and at most 180 days; 1 = conditions hash (missing reads as zero). Words 2+ are
    /// reserved. The current policy compares word 1 to bytes32(data), then exempts zero windows,
    /// live whitelisted takers and non-stake tokens. Manual release skips these checks.
    /// Data interpretation belongs to the snapshotted policy; O4 forwards it unchanged.
    /// @return deferralVault Zero to pay intent.to now; otherwise the vault that must receive
    /// netAmount before onDeferredPayoutFunded is called in the same transaction.
    function settleIntent(SettlementContext calldata context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    /// @dev O4 calls this in the same transaction immediately after transferring the net payout.
    /// Skipping it leaves the current policy's SETTLED deferred record without a vault lock.
    function onDeferredPayoutFunded(bytes32 intentHash) external;
}
