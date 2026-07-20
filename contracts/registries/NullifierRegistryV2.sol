// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { AddressArrayUtils } from "../external/AddressArrayUtils.sol";
import { INullifierRegistry } from "../interfaces/INullifierRegistry.sol";
import { INullifierRegistryV2 } from "../interfaces/INullifierRegistryV2.sol";

/**
 * @title NullifierRegistryV2
 * @notice Enforces payment replay protection while binding every new payment to exactly one intent.
 * @dev The immutable predecessor keeps every pre-cutover nullifier authoritative. New writes are local
 *      and bidirectional; neither side of a binding can ever be replaced.
 * @dev CUTOVER INVARIANT: before this registry accepts its first live write, every retired verifier must
 *      permanently lose write permission on the legacy registry and payment methods must never be routed
 *      back to it. The legacy registry cannot observe V2 writes, so rollback would otherwise reopen replay.
 */
contract NullifierRegistryV2 is Ownable, INullifierRegistryV2 {
    using AddressArrayUtils for address[];

    INullifierRegistry public immutable override legacyNullifierRegistry;

    mapping(bytes32 => bytes32) public override intentHashByNullifier;
    mapping(bytes32 => bytes32) public override nullifierByIntentHash;
    mapping(address => bool) public override isWriter;
    address[] internal writers;

    modifier onlyWriter() {
        if (!isWriter[msg.sender]) revert UnauthorizedWriter(msg.sender);
        _;
    }

    constructor(INullifierRegistry _legacyNullifierRegistry) Ownable() {
        if (address(_legacyNullifierRegistry).code.length == 0) revert ZeroAddress();
        legacyNullifierRegistry = _legacyNullifierRegistry;
    }

    function isNullified(bytes32 _nullifier) public view override returns (bool) {
        return intentHashByNullifier[_nullifier] != bytes32(0)
            || legacyNullifierRegistry.isNullified(_nullifier);
    }

    function addNullifier(bytes32 _nullifier, bytes32 _intentHash) external override onlyWriter {
        if (_nullifier == bytes32(0)) revert ZeroNullifier();
        if (_intentHash == bytes32(0)) revert ZeroIntentHash();
        if (isNullified(_nullifier)) revert NullifierAlreadyExists(_nullifier);

        bytes32 existingNullifier = nullifierByIntentHash[_intentHash];
        if (existingNullifier != bytes32(0)) {
            revert IntentAlreadyBound(_intentHash, existingNullifier);
        }

        intentHashByNullifier[_nullifier] = _intentHash;
        nullifierByIntentHash[_intentHash] = _nullifier;

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
