// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";

/// @dev Stateful replay driver with explicit expected-revert accounting.
contract NullifierHandler is Test {
    uint256 public constant SLOT_COUNT = 16;

    NullifierRegistry public immutable legacyRegistry;
    NullifierRegistryV2 public immutable registry;
    mapping(bytes32 => bytes32) public ghostIntentByNullifier;
    mapping(bytes32 => bytes32) public ghostNullifierByIntent;
    mapping(bytes32 => bool) public ghostLegacyNullifier;
    uint256 public totalCalls;
    uint256 public successfulBindings;
    uint256 public successfulLegacyWrites;
    uint256 public rejectedCalls;
    uint256 public unauthorizedAttempts;
    uint256 public unauthorizedSuccesses;

    constructor(NullifierRegistry legacyRegistry_, NullifierRegistryV2 registry_) {
        legacyRegistry = legacyRegistry_;
        registry = registry_;
    }

    function nullifierAt(uint256 slot) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("stateful-nullifier", slot));
    }

    function intentAt(uint256 slot) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("stateful-intent", slot));
    }

    function _call(address caller, address target, bytes memory data) internal returns (bool success) {
        if (caller != address(this)) vm.prank(caller);
        (success,) = target.call(data);
    }

    function bind(uint256 nullifierSeed, uint256 intentSeed) external {
        bytes32 nullifier = nullifierAt(nullifierSeed % SLOT_COUNT);
        bytes32 intentHash = intentAt(intentSeed % SLOT_COUNT);
        bool success =
            _call(address(this), address(registry), abi.encodeCall(registry.addNullifier, (nullifier, intentHash)));
        ++totalCalls;
        if (success) {
            ++successfulBindings;
            ghostIntentByNullifier[nullifier] = intentHash;
            ghostNullifierByIntent[intentHash] = nullifier;
        } else {
            ++rejectedCalls;
        }
    }

    function consumeLegacyThenAttemptV2(uint256 nullifierSeed, uint256 intentSeed) external {
        bytes32 nullifier = nullifierAt(nullifierSeed % SLOT_COUNT);
        bytes32 intentHash = intentAt(intentSeed % SLOT_COUNT);
        if (!legacyRegistry.isNullified(nullifier) && registry.intentHashByNullifier(nullifier) == bytes32(0)) {
            bool legacySuccess =
                _call(address(this), address(legacyRegistry), abi.encodeCall(legacyRegistry.addNullifier, (nullifier)));
            if (legacySuccess) {
                ++successfulLegacyWrites;
                ghostLegacyNullifier[nullifier] = true;
            }
        }
        bool v2Success =
            _call(address(this), address(registry), abi.encodeCall(registry.addNullifier, (nullifier, intentHash)));
        ++totalCalls;
        if (v2Success) {
            ++successfulBindings;
            ghostIntentByNullifier[nullifier] = intentHash;
            ghostNullifierByIntent[intentHash] = nullifier;
        } else {
            ++rejectedCalls;
        }
    }

    function unauthorizedWrite(uint256 attackerSeed, uint256 nullifierSeed, uint256 intentSeed) external {
        address attacker = address(uint160(0xD100 + attackerSeed % 100));
        ++unauthorizedAttempts;
        bool success = _call(
            attacker,
            address(registry),
            abi.encodeCall(
                registry.addNullifier, (nullifierAt(nullifierSeed % SLOT_COUNT), intentAt(intentSeed % SLOT_COUNT))
            )
        );
        if (success) ++unauthorizedSuccesses;
        ++totalCalls;
        if (success) ++successfulBindings;
        else ++rejectedCalls;
    }
}
