// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IAddressGroupRegistry} from "../interfaces/IAddressGroupRegistry.sol";
import {IEscrow} from "../interfaces/IEscrow.sol";
import {IWhitelistPolicyV2} from "../interfaces/IWhitelistPolicyV2.sol";

/**
 * @title WhitelistPolicyV2
 * @notice Per-deposit taker whitelist for OrchestratorV4. A taker is whitelisted directly or as a member of a group
 * it names; when the whitelist is enabled, only whitelisted takers may signal. Allowing a group accepts its
 * arbitrator for intents signaled through it.
 */
contract WhitelistPolicyV2 is IWhitelistPolicyV2 {

    /* ============ State Variables ============ */

    IAddressGroupRegistry public immutable override groupRegistry;

    mapping(address => mapping(uint256 => bool)) public override enabled;                    // escrow => depositId
    mapping(address => mapping(uint256 => mapping(bytes32 => bool))) public allowedGroups;   // escrow => depositId => groupId
    mapping(address => mapping(uint256 => mapping(address => bool))) public allowedTakers;   // escrow => depositId => taker

    /* ============ Constructor ============ */

    constructor(IAddressGroupRegistry _groupRegistry) {
        groupRegistry = _groupRegistry;
    }

    /* ============ Modifiers ============ */

    modifier onlyDepositor(address _escrow, uint256 _depositId) {
        if (IEscrow(_escrow).getDeposit(_depositId).depositor != msg.sender) {
            revert NotDepositor(_escrow, _depositId, msg.sender);
        }
        _;
    }

    /* ============ Depositor Functions ============ */

    /// @notice Turns the whitelist on, so only whitelisted takers may signal, or off.
    function setEnabled(address _escrow, uint256 _depositId, bool _enabled) external onlyDepositor(_escrow, _depositId) {
        enabled[_escrow][_depositId] = _enabled;
        emit EnabledUpdated(_escrow, _depositId, _enabled);
    }

    /// @notice Allows or removes groups. Allowing a group accepts its arbitrator.
    function setGroups(address _escrow, uint256 _depositId, bytes32[] calldata _groupIds, bool _allowed)
        external
        onlyDepositor(_escrow, _depositId)
    {
        for (uint256 i = 0; i < _groupIds.length; i++) {
            allowedGroups[_escrow][_depositId][_groupIds[i]] = _allowed;
            emit GroupUpdated(_escrow, _depositId, _groupIds[i], _allowed);
        }
    }

    /// @notice Allows or removes direct takers.
    function setTakers(address _escrow, uint256 _depositId, address[] calldata _takers, bool _allowed)
        external
        onlyDepositor(_escrow, _depositId)
    {
        for (uint256 i = 0; i < _takers.length; i++) {
            allowedTakers[_escrow][_depositId][_takers[i]] = _allowed;
            emit TakerUpdated(_escrow, _depositId, _takers[i], _allowed);
        }
    }

    /* ============ View Functions ============ */

    /// @inheritdoc IWhitelistPolicyV2
    function isWhitelisted(address _escrow, uint256 _depositId, address _taker, bytes32 _groupId)
        external
        view
        override
        returns (bool)
    {
        if (_groupId == bytes32(0)) return allowedTakers[_escrow][_depositId][_taker];
        return allowedGroups[_escrow][_depositId][_groupId] && groupRegistry.isMember(_groupId, _taker);
    }
}
