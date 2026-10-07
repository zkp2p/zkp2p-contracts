// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {DisputeProtectionPolicy} from "./DisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title DisputeProtectionPolicyV2
 * @notice Proof-selected collateral windows over the existing vault. Only settled predecessor records may be
 * adopted, on their first release or dispute. Pending predecessor orders must drain before controller handover.
 */
contract DisputeProtectionPolicyV2 is DisputeProtectionPolicy, IDisputeProtectionPolicyV2 {
    DisputeProtectionPolicy public immutable predecessor;

    constructor(
        address _owner,
        IStakeVault _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry,
        DisputeProtectionPolicy _predecessor
    ) DisputeProtectionPolicy(_owner, _stakeVault, _disputeVerifier, _disputeNullifierRegistry) {
        _validateDependency(address(_predecessor));
        require(address(_predecessor.stakeVault()) == address(_stakeVault), "DPP: Predecessor vault mismatch");
        require(
            address(_predecessor.disputeVerifier()) == address(_disputeVerifier), "DPP: Predecessor verifier mismatch"
        );
        require(
            address(_predecessor.disputeNullifierRegistry()) == address(_disputeNullifierRegistry),
            "DPP: Predecessor registry mismatch"
        );
        predecessor = _predecessor;
    }

    /**
     * @notice AUTHORIZED HOOK ONLY: Settles a pending local lock with the authenticated policy's hold.
     * @dev Zero releases the entire original lock immediately; positive holds resize to the verified gross payout.
     * The saved riskWindow remains the admission default for manual settlement and future policy selections.
     */
    function onIntentSettledWithWindow(bytes32 _intentHash, uint256 _releaseAmount, uint64 _window)
        external
        override
        onlyLifecycleHook
        nonReentrant
    {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.status != DisputeProtectionIntentStatus.PENDING) {
            revert DisputeProtectionIntentNotPending(_intentHash, intent.status);
        }
        if (_window > MAX_RISK_WINDOW) revert InvalidRiskWindow(_window);
        (address stakeOwner, uint256 amount,) = stakeVault.locks(_intentHash);
        require(stakeOwner == intent.stakeOwner, "DPP: Lock owner mismatch");
        require(_releaseAmount > 0 && _releaseAmount <= amount, "DPP: Invalid settlement amount");
        _settleIntent(_intentHash, _releaseAmount, _window, false);
    }

    /// @notice Returns local authoritative state, or the predecessor's immutable history before adoption.
    function getDisputeProtectionIntent(bytes32 _intentHash)
        public
        view
        override
        returns (DisputeProtectionIntent memory)
    {
        DisputeProtectionIntent memory intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.status != DisputeProtectionIntentStatus.NONE) return intent;
        return predecessor.getDisputeProtectionIntent(_intentHash);
    }

    function _loadIntent(bytes32 _intentHash) internal override returns (DisputeProtectionIntent storage intent) {
        intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.status != DisputeProtectionIntentStatus.NONE) return intent;
        require(stakeVault.controller() == address(this), "DPP: Not vault controller");
        DisputeProtectionIntent memory previous = predecessor.getDisputeProtectionIntent(_intentHash);
        if (previous.status != DisputeProtectionIntentStatus.SETTLED) {
            revert DisputeProtectionIntentNotSettled(_intentHash, previous.status);
        }
        (address stakeOwner, uint256 amount, uint64 maturesAt) = stakeVault.locks(_intentHash);
        require(
            stakeOwner == previous.stakeOwner && amount == previous.releaseAmount
                && maturesAt == previous.releaseEligibleAt,
            "DPP: Predecessor lock mismatch"
        );
        disputeProtectionIntentByIntentHash[_intentHash] = previous;
        emit LegacyIntentAdopted(_intentHash);
    }
}
