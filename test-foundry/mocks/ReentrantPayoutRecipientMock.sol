// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/// @notice Payout recipient that re-enters a target from a token hook once and records how each attempt ended.
contract ReentrantPayoutRecipientMock {
    address internal target;
    bytes[] internal payloads;
    bytes[] internal failures;
    uint256 public reentrySuccesses;
    uint256 public hookCalls;

    function arm(address _target, bytes[] memory _payloads) external {
        target = _target;
        payloads = _payloads;
    }

    function onTokenReceived(uint256) external {
        hookCalls++;
        bytes[] memory pending = payloads;
        delete payloads;
        for (uint256 index; index < pending.length; ++index) {
            (bool success, bytes memory returnData) = target.call(pending[index]);
            if (success) reentrySuccesses++;
            else failures.push(returnData);
        }
    }

    function failure(uint256 _index) external view returns (bytes memory) {
        return failures[_index];
    }

    function failureCount() external view returns (uint256) {
        return failures.length;
    }
}
