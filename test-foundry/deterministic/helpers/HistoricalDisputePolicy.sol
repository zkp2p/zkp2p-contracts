// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";

/// @dev ABI of the executed lane-39 policy, used only by its historical activation tests.
interface HistoricalDisputePolicy is IDisputeProtectionPolicy {
    function setRiskWindow(bytes32 method, uint64 window) external;
    function getRiskWindow(bytes32 method) external view returns (uint64);
    function setLifecycleHookAuthorization(address hook, bool authorized) external;
    function setDisputeProtectionEnabled(address escrow, uint256 depositId, bytes32 method, bool enabled) external;
    function setAdmissionsPaused(bool paused) external;
    function admissionsPaused() external view returns (bool);
    function transferOwnership(address owner) external;
    function acceptOwnership() external;
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function acceptVaultController() external;
    function isLifecycleHookAuthorized(address hook) external view returns (bool);
    function stakeVault() external view returns (IStakeVault);
    function disputeVerifier() external view returns (IDisputeVerifier);
    function disputeNullifierRegistry() external view returns (INullifierRegistry);
    function getDisputeProtectionIntent(bytes32 intentHash) external view returns (DisputeProtectionIntent memory);
    function releaseMaturedDisputeProtectionIntent(bytes32 intentHash) external;
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata attestation) external;
}

library HistoricalDisputePolicyDeployer {
    function deploy(address owner, IStakeVault vault, IDisputeVerifier verifier, INullifierRegistry registry)
        internal
        returns (HistoricalDisputePolicy)
    {
        // Reuse the committed creation artifact; never substitute current source for executed migration history.
        string[] memory command = new string[](3);
        command[0] = "python3";
        command[1] = "-c";
        command[2] =
            "import json; print(json.load(open('deployments/base/DisputeProtectionPolicyMethodScopedStaked.json'))['bytecode'])";
        bytes memory code = Vm(address(uint160(uint256(keccak256("hevm cheat code"))))).ffi(command);
        require(
            keccak256(code) == 0x41b843daa1ae91f90b5fdaa4f176f4c3c378c21cc14e0707781a2a01a85bf1ee,
            "Historical policy changed"
        );
        bytes memory creation = abi.encodePacked(code, abi.encode(owner, vault, verifier, registry));
        address deployed;
        assembly { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "Historical policy deployment failed");
        return HistoricalDisputePolicy(deployed);
    }
}
