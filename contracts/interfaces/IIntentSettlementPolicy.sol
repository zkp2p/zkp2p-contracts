// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Minimal settlement boundary used by OrchestratorV4.
/// @dev O4 depends only on these two functions. A replacement policy needs to implement only this
/// settlement interface (and advertise it through ERC-165), so settlement rules can change without
/// deploying another orchestrator. O4 applies its current policy at settlement.
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
        bytes extensionData;
        bool isManualRelease;
    }

    /// @notice Selects immediate or deferred settlement.
    /// @dev Signed extension word 0 = dispute window (uint256 seconds), required for non-manual
    /// settlements and at most 180 days. Later words are reserved. The current policy exempts zero windows,
    /// live whitelisted takers and non-stake tokens. Manual release skips these checks.
    /// @return deferralVault Zero to pay intent.to now; otherwise the vault that must receive
    /// netAmount before onDeferredPayoutFunded is called in the same transaction.
    function settleIntent(SettlementContext calldata context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    /// @dev O4 calls this in the same transaction immediately after transferring the net payout.
    /// Skipping it leaves the current policy's SETTLED deferred record without a vault lock.
    function onDeferredPayoutFunded(bytes32 intentHash) external;
}
