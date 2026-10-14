// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Admission and deferred settlement callbacks for compatible orchestrators.
interface IIntentLifecycleHookV2 {
    struct SettlementContext {
        bytes32 intentHash;
        address token;
        address recipient;
        uint256 releaseAmount;
        uint256 netAmount;
        bool balanceFunded;
        bool isManualRelease;
    }

    /// @notice Validates admission using the calling orchestrator's stored intent.
    function onIntentSignaled(bytes32 _intentHash) external;

    /// @notice Cancels the intent's policy record.
    function onIntentCancelled(bytes32 _intentHash) external;

    /// @notice Selects immediate or deferred settlement using the signed balance flag.
    /// @return deferralVault Zero to pay out now; otherwise the vault that must receive netAmount before onDeferredPayoutFunded.
    function settleIntent(SettlementContext calldata _context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;

}
