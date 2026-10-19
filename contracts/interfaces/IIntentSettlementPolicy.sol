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
        bytes32 paymentMethod;
        uint256 releaseAmount;
        uint256 netAmount;
        bytes settlementData; // Signed by the attestor; opaque to O4
    }

    /// @notice Selects immediate or deferred settlement.
    /// @dev O4 calls this only for verified fulfilments by takers that were not whitelisted at signal.
    /// DisputeProtectionPolicyV2 reads settlementData as abi.encode(uint256 disputeWindow), at most 180 days.
    /// The current policy pays zero windows and non-stake tokens now.
    /// @return deferralVault Zero to pay intent.to now; otherwise the vault that must receive
    /// netAmount before onDeferredPayoutFunded is called in the same transaction.
    function settleIntent(SettlementContext calldata context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    /// @dev O4 calls this in the same transaction immediately after transferring the net payout.
    /// Skipping it leaves the current policy's SETTLED deferred record without a vault lock.
    function onDeferredPayoutFunded(bytes32 intentHash) external;
}
