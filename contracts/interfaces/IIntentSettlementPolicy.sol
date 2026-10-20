// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Minimal settlement boundary used by OrchestratorV4.
/// @dev O4 depends only on these two functions, so settlement rules can change without deploying another
/// orchestrator. O4 applies its current policy at settlement.
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

    /// @notice Selects immediate or deferred settlement for a verified fulfilment by a non-whitelisted taker.
    /// @return deferralVault Zero to pay intent.to now; otherwise the vault that receives netAmount.
    function settleIntent(SettlementContext calldata context) external returns (address deferralVault);

    /// @notice Locks the net payout O4 just transferred to the deferral vault.
    /// @dev O4 passes the same context it passed to settleIntent, in the same transaction.
    function onDeferredPayoutFunded(SettlementContext calldata context) external;
}
