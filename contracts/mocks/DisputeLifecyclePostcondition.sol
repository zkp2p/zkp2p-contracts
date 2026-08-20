// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

interface IOwnedPostcondition {
    function owner() external view returns (address);
}

interface IWriterPostcondition is IOwnedPostcondition {
    function getWriters() external view returns (address[] memory);
}

interface IStakeVaultPostcondition is IOwnedPostcondition {
    function controller() external view returns (address);
    function pendingController() external view returns (address);
    function totalStaked() external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function totalAccounted() external view returns (uint256);
    function unaccountedBalance() external view returns (uint256);
}

interface IPolicyPostcondition is IOwnedPostcondition {
    function isLifecycleHookAuthorized(address hook) external view returns (bool);
    function getRiskWindow(bytes32 paymentMethod) external view returns (uint64);
}

interface IOrchestratorPostcondition {
    function lifecycleHook() external view returns (address);
}

/**
 * @title DisputeLifecyclePostcondition
 * @notice Fork-only assertion target appended to the simulated MultiSendCallOnly payload.
 * @dev This contract is never part of the persisted Safe batch or a live deployment.
 */
contract DisputeLifecyclePostcondition {
    address private immutable expectedSafe;
    IOwnedPostcondition private immutable disputeVerifier;
    IWriterPostcondition private immutable disputeRegistry;
    address private immutable predecessorPolicy;
    IStakeVaultPostcondition private immutable predecessorVault;
    IStakeVaultPostcondition private immutable freshVault;
    IPolicyPostcondition private immutable freshPolicy;
    address private immutable freshHook;
    IOrchestratorPostcondition private immutable orchestrator;
    bytes32[] private paymentMethods;
    uint64[] private riskWindows;

    constructor(
        address _expectedSafe,
        IOwnedPostcondition _disputeVerifier,
        IWriterPostcondition _disputeRegistry,
        address _predecessorPolicy,
        IStakeVaultPostcondition _predecessorVault,
        IStakeVaultPostcondition _freshVault,
        IPolicyPostcondition _freshPolicy,
        address _freshHook,
        IOrchestratorPostcondition _orchestrator,
        bytes32[] memory _paymentMethods,
        uint64[] memory _riskWindows
    ) {
        require(_expectedSafe != address(0), "safe");
        require(_paymentMethods.length == _riskWindows.length, "windows");
        expectedSafe = _expectedSafe;
        disputeVerifier = _disputeVerifier;
        disputeRegistry = _disputeRegistry;
        predecessorPolicy = _predecessorPolicy;
        predecessorVault = _predecessorVault;
        freshVault = _freshVault;
        freshPolicy = _freshPolicy;
        freshHook = _freshHook;
        orchestrator = _orchestrator;
        paymentMethods = _paymentMethods;
        riskWindows = _riskWindows;
    }

    function assertPostconditions() external view {
        require(disputeVerifier.owner() == expectedSafe, "verifier owner");
        require(disputeRegistry.owner() == expectedSafe, "registry owner");
        require(freshVault.owner() == expectedSafe, "vault owner");
        require(freshPolicy.owner() == expectedSafe, "policy owner");

        address[] memory writers = disputeRegistry.getWriters();
        require(writers.length == 1 && writers[0] == address(freshPolicy), "writers");
        require(orchestrator.lifecycleHook() == freshHook, "hook");
        require(freshVault.controller() == address(freshPolicy), "controller");
        require(freshVault.pendingController() == address(0), "pending controller");
        require(freshPolicy.isLifecycleHookAuthorized(freshHook), "authorization");

        for (uint256 methodIndex = 0; methodIndex < paymentMethods.length; methodIndex++) {
            require(freshPolicy.getRiskWindow(paymentMethods[methodIndex]) == riskWindows[methodIndex], "risk window");
        }
        _assertEmpty(predecessorVault);
        _assertEmpty(freshVault);
    }

    function _assertEmpty(IStakeVaultPostcondition vault) private view {
        require(vault.totalStaked() == 0, "total staked");
        require(vault.totalClaimable() == 0, "total claimable");
        require(vault.totalAccounted() == 0, "total accounted");
        require(vault.unaccountedBalance() == 0, "unaccounted");
    }
}
