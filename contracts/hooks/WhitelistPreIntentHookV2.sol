// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IAddressGroupRegistry } from "../interfaces/IAddressGroupRegistry.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";

/**
 * @title WhitelistPreIntentHookV2
 * @notice Unified whitelist hook: a taker may signal against a deposit when they are directly
 * whitelisted OR a member of any attached AddressGroupRegistry group. Allow-only; no blocklist.
 * @dev Supersedes WhitelistPreIntentHook for new deposits. Configuration is keyed by
 * (escrow, depositId) and persists if the deposit's orchestrator whitelist-hook slot is unset
 * (whitelist paused) and later reattached (resumed). Membership is point-in-time admission
 * authorization: removal does not invalidate already-signaled intents.
 *
 * TRUST MODEL: attaching a group delegates ongoing admission policy for the deposit to that
 * group's controller set (current/future owner and resolver) — see AddressGroupRegistry.
 */
contract WhitelistPreIntentHookV2 is IPreIntentHook {

    /* ============ Events ============ */

    event TakerWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event GroupAttached(address indexed escrow, uint256 indexed depositId, uint256 indexed groupId);
    event GroupDetached(address indexed escrow, uint256 indexed depositId, uint256 indexed groupId);

    /* ============ Errors ============ */

    error ZeroAddress();
    error EmptyArray();
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);
    error UnauthorizedOrchestratorCaller(address caller);
    error TakerNotWhitelisted(address taker, address escrow, uint256 depositId);
    error GroupDoesNotExist(uint256 groupId);
    error MaxGroupsExceeded(uint256 attempted, uint256 max);

    /* ============ Constants ============ */

    uint256 public constant MAX_GROUPS_PER_DEPOSIT = 10;

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    IAddressGroupRegistry public immutable groupRegistry;

    // escrow => depositId => taker => whitelisted
    mapping(address => mapping(uint256 => mapping(address => bool))) public whitelist;
    // escrow => depositId => attached group ids (enumerable, max MAX_GROUPS_PER_DEPOSIT)
    mapping(address => mapping(uint256 => uint256[])) internal attachedGroups;
    // escrow => depositId => groupId => index+1 in attachedGroups (0 = not attached)
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) internal attachedGroupIndexPlusOne;

    /* ============ Constructor ============ */

    constructor(address _orchestratorRegistry, address _groupRegistry) {
        if (_orchestratorRegistry == address(0) || _groupRegistry == address(0)) revert ZeroAddress();

        orchestratorRegistry = IOrchestratorRegistry(_orchestratorRegistry);
        groupRegistry = IAddressGroupRegistry(_groupRegistry);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Adds takers to a deposit's direct whitelist. Idempotent: already-whitelisted
     * takers are skipped (no event).
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _takers      Taker addresses to whitelist.
     */
    function addToWhitelist(address _escrow, uint256 _depositId, address[] calldata _takers) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_takers.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        for (uint256 i = 0; i < _takers.length; i++) {
            address taker = _takers[i];
            if (taker == address(0)) revert ZeroAddress();
            if (!whitelist[_escrow][_depositId][taker]) {
                whitelist[_escrow][_depositId][taker] = true;
                emit TakerWhitelisted(_escrow, _depositId, taker);
            }
        }
    }

    /**
     * @notice Removes takers from a deposit's direct whitelist. Idempotent: absent takers are
     * skipped (no event). Removal does not invalidate already-signaled intents.
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _takers      Taker addresses to remove.
     */
    function removeFromWhitelist(address _escrow, uint256 _depositId, address[] calldata _takers) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_takers.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        for (uint256 i = 0; i < _takers.length; i++) {
            address taker = _takers[i];
            if (taker == address(0)) revert ZeroAddress();
            if (whitelist[_escrow][_depositId][taker]) {
                whitelist[_escrow][_depositId][taker] = false;
                emit TakerRemovedFromWhitelist(_escrow, _depositId, taker);
            }
        }
    }

    /**
     * @inheritdoc IPreIntentHook
     */
    function validateSignalIntent(PreIntentContext calldata _ctx) external view override {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestratorCaller(msg.sender);

        if (whitelist[_ctx.escrow][_ctx.depositId][_ctx.taker]) return;

        uint256[] storage groupIds = attachedGroups[_ctx.escrow][_ctx.depositId];
        for (uint256 i = 0; i < groupIds.length; i++) {
            if (groupRegistry.isMember(groupIds[i], _ctx.taker)) return;
        }

        revert TakerNotWhitelisted(_ctx.taker, _ctx.escrow, _ctx.depositId);
    }

    /**
     * @notice Attaches groups to a deposit. Idempotent: already-attached ids are skipped
     * (no event). Validates each group exists in the registry (input validation only — not a
     * trust guarantee about the group's governance).
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _groupIds    Group ids to attach (max MAX_GROUPS_PER_DEPOSIT attached in total).
     */
    function attachGroups(address _escrow, uint256 _depositId, uint256[] calldata _groupIds) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_groupIds.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        uint256[] storage attached = attachedGroups[_escrow][_depositId];
        for (uint256 i = 0; i < _groupIds.length; i++) {
            uint256 groupId = _groupIds[i];
            if (!groupRegistry.groupExists(groupId)) revert GroupDoesNotExist(groupId);
            if (attachedGroupIndexPlusOne[_escrow][_depositId][groupId] != 0) continue;
            if (attached.length >= MAX_GROUPS_PER_DEPOSIT) {
                revert MaxGroupsExceeded(attached.length + 1, MAX_GROUPS_PER_DEPOSIT);
            }
            attached.push(groupId);
            attachedGroupIndexPlusOne[_escrow][_depositId][groupId] = attached.length;
            emit GroupAttached(_escrow, _depositId, groupId);
        }
    }

    /**
     * @notice Detaches groups from a deposit. Idempotent: ids not currently attached are
     * skipped (no event). Detachment does not invalidate already-signaled intents.
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _groupIds    Group ids to detach.
     */
    function detachGroups(address _escrow, uint256 _depositId, uint256[] calldata _groupIds) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_groupIds.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        uint256[] storage attached = attachedGroups[_escrow][_depositId];
        for (uint256 i = 0; i < _groupIds.length; i++) {
            uint256 groupId = _groupIds[i];
            uint256 indexPlusOne = attachedGroupIndexPlusOne[_escrow][_depositId][groupId];
            if (indexPlusOne == 0) continue;

            uint256 lastId = attached[attached.length - 1];
            attached[indexPlusOne - 1] = lastId;
            attachedGroupIndexPlusOne[_escrow][_depositId][lastId] = indexPlusOne;
            attached.pop();
            delete attachedGroupIndexPlusOne[_escrow][_depositId][groupId];
            emit GroupDetached(_escrow, _depositId, groupId);
        }
    }
    /* ============ External View Functions ============ */

    /**
     * @notice Returns whether a taker is on the deposit's direct whitelist (groups excluded).
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _taker       Taker address to check.
     */
    function isWhitelisted(address _escrow, uint256 _depositId, address _taker) external view returns (bool) {
        return whitelist[_escrow][_depositId][_taker];
    }

    /**
     * @notice Returns all group ids attached to a deposit.
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     */
    function getAttachedGroups(address _escrow, uint256 _depositId) external view returns (uint256[] memory) {
        return attachedGroups[_escrow][_depositId];
    }

    /**
     * @notice Returns whether a group is attached to a deposit.
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _groupId     Group id.
     */
    function isGroupAttached(address _escrow, uint256 _depositId, uint256 _groupId) external view returns (bool) {
        return attachedGroupIndexPlusOne[_escrow][_depositId][_groupId] != 0;
    }

    /**
     * @notice Full effective admission check — same semantics as validateSignalIntent without
     * the orchestrator gate or revert.
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _taker       Taker address to check.
     */
    function isAllowedTaker(address _escrow, uint256 _depositId, address _taker) external view returns (bool) {
        if (whitelist[_escrow][_depositId][_taker]) return true;

        uint256[] storage groupIds = attachedGroups[_escrow][_depositId];
        for (uint256 i = 0; i < groupIds.length; i++) {
            if (groupRegistry.isMember(groupIds[i], _taker)) return true;
        }
        return false;
    }
    /* ============ Internal Functions ============ */

    function _validateDepositorOrDelegate(address _escrow, uint256 _depositId) internal view {
        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }
    }
}
