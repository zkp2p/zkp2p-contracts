// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ActivationDisputeProtectionIntent, IActivationPolicy} from "./DisputeMethodScopedActivationTypes.sol";
import {
    DisputeMethodScopedVaultTrustSurfaceChecks,
    IActivationVaultWithToken,
    VaultTrustSurface
} from "./DisputeMethodScopedVaultActivationTypes.sol";

contract DisputeMethodScopedVaultWriterRemovalGuard is DisputeMethodScopedVaultTrustSurfaceChecks {
    uint8 private constant CANCELLED = 2;
    uint8 private constant RELEASED = 4;
    uint8 private constant DISPUTED = 5;
    bytes32[] private intentHashes;

    constructor(VaultTrustSurface memory _expected, bytes32[] memory _intentHashes)
        DisputeMethodScopedVaultTrustSurfaceChecks(_expected)
    {
        intentHashes = _intentHashes;
    }

    function assertReady() external view {
        _assertTrustSurface();
        _assertFreshSafeOwnership();
        address[] memory writers = new address[](2);
        writers[0] = expected.predecessorPolicy;
        writers[1] = expected.freshPolicy;
        _assertWriters(writers);
        _assertLifecycleHook(expected.freshHook);
        _assertFreshPolicyConfiguration();

        IActivationPolicy predecessor = IActivationPolicy(expected.predecessorPolicy);
        IActivationVaultWithToken predecessorVault = IActivationVaultWithToken(expected.vaults.predecessorVault);
        for (uint256 intentIndex = 0; intentIndex < intentHashes.length; intentIndex++) {
            bytes32 intentHash = intentHashes[intentIndex];
            ActivationDisputeProtectionIntent memory intent = predecessor.getDisputeProtectionIntent(intentHash);
            if (intent.status != CANCELLED && intent.status != RELEASED && intent.status != DISPUTED) {
                revert PredecessorIntentStatusMismatch(intentHash, intent.status);
            }
            (, uint256 amount,) = predecessorVault.locks(intentHash);
            if (amount != 0) revert PredecessorIntentLockAmountMismatch(intentHash, amount);
        }
    }
}
