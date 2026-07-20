// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";

/**
 * @title RiskCallbackRecorder
 * @notice Records retry data when a fail-open terminal risk callback does not complete.
 */
library RiskCallbackRecorder {
    event IntentCancellationRecorded(bytes32 indexed intentHash, uint64 cancelledAt);

    /** @notice Stores the canonical terminal data only when the callback failed. */
    function recordFailure(
        mapping(bytes32 => IOrchestratorV3.IntentSettlement) storage _failedSettlements,
        mapping(bytes32 => IOrchestratorV3.IntentCancellation) storage _failedCancellations,
        bytes32 _intentHash,
        uint8 _resolution,
        uint256 _releasedAmount,
        uint64 _resolvedAt,
        bool _callbackSucceeded
    ) external {
        if (_callbackSucceeded) return;
        if (_resolution != 0) {
            _failedSettlements[_intentHash] = IOrchestratorV3.IntentSettlement({
                releasedAmount: _releasedAmount,
                settledAt: _resolvedAt,
                isManualRelease: _resolution == 2
            });
        } else {
            _failedCancellations[_intentHash] = IOrchestratorV3.IntentCancellation({
                cancelledAt: _resolvedAt
            });
            emit IntentCancellationRecorded(_intentHash, _resolvedAt);
        }
    }
}
