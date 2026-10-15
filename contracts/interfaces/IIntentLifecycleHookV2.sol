// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Admission and deferred settlement callbacks for compatible orchestrators.
interface IIntentLifecycleHookV2 {
    struct SettlementContext {
        bytes32 intentHash;
        address token;
        address depositor; // Captured by the orchestrator before escrow unlock can delete the deposit.
        address taker;
        address recipient;
        address escrow;
        uint256 depositId;
        bytes32 paymentMethod;
        uint256 releaseAmount;
        uint256 netAmount;
        bytes data;
        bytes extensionData;
        bool isManualRelease;
    }

    /// @notice Validates admission using the calling orchestrator's stored intent and opaque hook data.
    /// @dev IntentLifecycleHookV2 reads bytes32(_data): a raw conditions hash, with empty or zero meaning none.
    /// Shorter data is right-padded and longer data uses its first word. The version lives in the hash preimage.
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _data) external;

    /// @notice Cancellation callback retained for future hooks; the current hook is an unrestricted no-op.
    function onIntentCancelled(bytes32 _intentHash) external;

    /// @notice Validates signed conditions and selects immediate or deferred settlement.
    /// @dev Signed extension words: 0 = disputeWindow (uint256 seconds), 1 = conditionsHash, 2+ = reserved.
    /// Non-manual settlement requires word 0 and rejects windows above 180 days. Missing word 1 reads as zero.
    /// Manual release ignores the extension and skips the policy. Window zero validates conditions then pays now
    /// without calling the policy. Nonzero windows use stake or deferred payouts only for stake-token deposits.
    /// Whitelisted takers bypass collateral; relayer registration alone does not. Whitelisting requires the
    /// deposit/payment-method whitelist to be enabled and the taker allowed at settlement; disabling it or
    /// removing the taker after signal restores the cascade for nonzero windows.
    /// Data interpretation lives in each intent's snapshotted hook because OrchestratorV4 is not upgradeable.
    /// @return deferralVault Zero to pay out now; otherwise the vault that must receive netAmount before onDeferredPayoutFunded.
    function settleIntent(SettlementContext calldata _context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;

}
