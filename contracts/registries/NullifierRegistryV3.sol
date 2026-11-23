// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AddressArrayUtils } from "../external/AddressArrayUtils.sol";
import { INullifierRegistryV2 } from "../interfaces/INullifierRegistryV2.sol";
import { INullifierRegistryV3 } from "../interfaces/INullifierRegistryV3.sol";

/**
 * @title NullifierRegistryV3
 * @notice Enforces payment replay protection while binding every nullifier to the intent it fulfilled. A payment
 *         can consume several nullifiers, so one intent can hold many.
 * @dev The registry stores opaque keys and holds no rule about how they are derived, how many belong to an
 *      intent, or what they mean.
 * @dev The immutable predecessor keeps every pre-cutover nullifier and binding authoritative. New writes are
 *      local; a binding can never be replaced.
 * @dev CUTOVER INVARIANT: before this registry accepts its first live write, every retired verifier must
 *      permanently lose write permission on the predecessor and payment methods must never be routed
 *      back to it. The predecessor cannot observe V3 writes, so rollback would otherwise reopen replay.
 */
contract NullifierRegistryV3 is Ownable, INullifierRegistryV3 {
    using AddressArrayUtils for address[];

    INullifierRegistryV2 public immutable override predecessor;

    mapping(bytes32 => bytes32) internal bindings;
    mapping(address => bool) public override isWriter;
    address[] internal writers;

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert UnauthorizedWriter(msg.sender);
        _;
    }

    constructor(INullifierRegistryV2 _predecessor) Ownable() {
        if (address(_predecessor).code.length == 0) revert ZeroAddress();
        predecessor = _predecessor;
    }

    /// @notice Intent a nullifier is bound to; zero if unused or consumed before the predecessor recorded intents.
    function intentHashByNullifier(bytes32 _nullifier) external view override returns (bytes32) {
        bytes32 intentHash = bindings[_nullifier];
        return intentHash != bytes32(0) ? intentHash : predecessor.intentHashByNullifier(_nullifier);
    }

    function isNullified(bytes32 _nullifier) public view override returns (bool) {
        return bindings[_nullifier] != bytes32(0) || predecessor.isNullified(_nullifier);
    }

    function addNullifier(bytes32 _nullifier, bytes32 _intentHash) external override onlyWriter {
        if (_nullifier == bytes32(0)) revert ZeroNullifier();
        if (_intentHash == bytes32(0)) revert ZeroIntentHash();
        if (isNullified(_nullifier)) revert NullifierAlreadyExists(_nullifier);

        bindings[_nullifier] = _intentHash;

        emit NullifierAdded(_nullifier, _intentHash, msg.sender);
    }

    function addWritePermission(address _writer) external override onlyOwner {
        if (_writer == address(0)) revert ZeroAddress();
        if (isWriter[_writer]) revert WriterAlreadyAuthorized(_writer);

        isWriter[_writer] = true;
        writers.push(_writer);
        emit WriterAdded(_writer);
    }

    function removeWritePermission(address _writer) external override onlyOwner {
        if (!isWriter[_writer]) revert WriterNotAuthorized(_writer);

        isWriter[_writer] = false;
        writers.removeStorage(_writer);
        emit WriterRemoved(_writer);
    }

    function getWriters() external view override returns (address[] memory) {
        return writers;
    }
}
