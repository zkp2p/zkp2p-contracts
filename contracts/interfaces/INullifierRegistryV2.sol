// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { INullifierRegistry } from "./INullifierRegistry.sol";

/**
 * @title INullifierRegistryV2
 * @notice Canonically binds each consumed payment nullifier to the intent it fulfilled.
 */
interface INullifierRegistryV2 {
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);

    error ZeroAddress();
    error ZeroNullifier();
    error ZeroIntentHash();
    error UnauthorizedWriter(address caller);
    error WriterAlreadyAuthorized(address writer);
    error WriterNotAuthorized(address writer);
    error NullifierAlreadyExists(bytes32 nullifier);
    error IntentAlreadyBound(bytes32 intentHash, bytes32 nullifier);

    function legacyNullifierRegistry() external view returns (INullifierRegistry);
    function isNullified(bytes32 _nullifier) external view returns (bool);
    function intentHashByNullifier(bytes32 _nullifier) external view returns (bytes32);
    function nullifierByIntentHash(bytes32 _intentHash) external view returns (bytes32);
    function addNullifier(bytes32 _nullifier, bytes32 _intentHash) external;
    function isWriter(address _writer) external view returns (bool);
    function getWriters() external view returns (address[] memory);
    function addWritePermission(address _writer) external;
    function removeWritePermission(address _writer) external;
}
