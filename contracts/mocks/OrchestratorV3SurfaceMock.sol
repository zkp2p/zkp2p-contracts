// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title OrchestratorV3SurfaceMock
 * @notice Minimal mutable implementation of the OrchestratorV3 trust surface for rehearsals and tests.
 */
contract OrchestratorV3SurfaceMock {
    error UnauthorizedOwner(address caller);

    address public owner;
    bool public paused;
    address public lifecycleHook;
    address public immutable escrowRegistry;
    address public immutable paymentVerifierRegistry;
    address public immutable relayerRegistry;
    uint256 public constant protocolFee = 0;
    address public immutable protocolFeeRecipient;
    bool public allowMultipleIntents;

    modifier onlyOwner() {
        if (msg.sender != owner) revert UnauthorizedOwner(msg.sender);
        _;
    }

    constructor(
        address _owner,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        address _relayerRegistry,
        address _protocolFeeRecipient
    ) {
        owner = _owner;
        escrowRegistry = _escrowRegistry;
        paymentVerifierRegistry = _paymentVerifierRegistry;
        relayerRegistry = _relayerRegistry;
        protocolFeeRecipient = _protocolFeeRecipient;
    }

    /**
     * @notice Sets the lifecycle hook exposed by the mock.
     */
    function setLifecycleHook(address _lifecycleHook) external onlyOwner {
        lifecycleHook = _lifecycleHook;
    }

    /**
     * @notice Sets the pause bit exposed by the mock.
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
    }

    /**
     * @notice Sets the multiple-intent bit exposed by the mock.
     */
    function setAllowMultipleIntents(bool _allowMultipleIntents) external onlyOwner {
        allowMultipleIntents = _allowMultipleIntents;
    }
}
