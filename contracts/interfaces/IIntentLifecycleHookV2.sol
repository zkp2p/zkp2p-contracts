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
        bytes lifecycleHookData;
        bytes extensionData;
        bool isManualRelease;
    }

    /// @notice Validates admission using the calling orchestrator's stored intent and opaque hook data.
    /// @dev V1 data is exactly abi.encode(uint8(1), bytes32 conditionsHash) with a nonzero hash; empty means none.
    function onIntentSignaled(bytes32 _intentHash, bytes calldata _lifecycleHookData) external;

    /// @notice Decodes the v1 conditions hash, returning zero for empty data and reverting on malformed data.
    /// @dev The hook is stateless by design; per-intent lifecycle hook data lives in the orchestrator.
    function conditionsHashOf(bytes calldata _lifecycleHookData) external pure returns (bytes32);

    /// @notice Cancels the intent's policy record.
    function onIntentCancelled(bytes32 _intentHash) external;

    /// @notice Validates signed conditions and selects immediate or deferred settlement.
    /// @dev Signed extension words: 0 = balanceFunded (only 0 or 1), 1 = conditionsHash, 2+ = reserved.
    /// Missing complete words read as zero. Manual release ignores the extension and uses balanceFunded = false.
    /// Decoding lives in the governance-replaceable hook because OrchestratorV4 is not upgradeable.
    /// @return deferralVault Zero to pay out now; otherwise the vault that must receive netAmount before onDeferredPayoutFunded.
    function settleIntent(SettlementContext calldata _context) external returns (address deferralVault);

    /// @notice Accounts for the net payout transferred to the deferral vault.
    function onDeferredPayoutFunded(bytes32 _intentHash) external;

}
