// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "../interfaces/IEscrow.sol";
import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";

/**
 * @title WhitelistPreIntentHook
 * @notice Pre-intent hook that restricts intent signaling to a depositor-managed whitelist of takers.
 * @dev Enables "private orderbook" functionality: deposits are visible on-chain but only
 * whitelisted addresses can lock liquidity against them.
 */
contract WhitelistPreIntentHook is IPreIntentHook {

    /* ============ Events ============ */

    event TakerWhitelisted(address indexed escrow, uint256 indexed depositId, address indexed taker);
    event TakerRemovedFromWhitelist(address indexed escrow, uint256 indexed depositId, address indexed taker);

    /* ============ Errors ============ */

    error ZeroAddress();
    error EmptyArray();
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);
    error UnauthorizedOrchestratorCaller(address caller);
    error TakerNotWhitelisted(address taker, address escrow, uint256 depositId);

    /* ============ State Variables ============ */

    address public immutable orchestrator;

    // escrow => depositId => taker => whitelisted
    mapping(address => mapping(uint256 => mapping(address => bool))) public whitelist;

    /* ============ Constructor ============ */

    constructor(address _orchestrator) {
        if (_orchestrator == address(0)) revert ZeroAddress();

        orchestrator = _orchestrator;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Adds takers to the whitelist for a specific deposit.
     * @dev Callable only by the deposit's depositor or delegate.
     *
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _takers      Array of taker addresses to whitelist.
     */
    function addToWhitelist(address _escrow, uint256 _depositId, address[] calldata _takers) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_takers.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        for (uint256 i = 0; i < _takers.length; i++) {
            whitelist[_escrow][_depositId][_takers[i]] = true;
            emit TakerWhitelisted(_escrow, _depositId, _takers[i]);
        }
    }

    /**
     * @notice Removes takers from the whitelist for a specific deposit.
     * @dev Callable only by the deposit's depositor or delegate.
     *
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _takers      Array of taker addresses to remove.
     */
    function removeFromWhitelist(address _escrow, uint256 _depositId, address[] calldata _takers) external {
        if (_escrow == address(0)) revert ZeroAddress();
        if (_takers.length == 0) revert EmptyArray();

        _validateDepositorOrDelegate(_escrow, _depositId);

        for (uint256 i = 0; i < _takers.length; i++) {
            whitelist[_escrow][_depositId][_takers[i]] = false;
            emit TakerRemovedFromWhitelist(_escrow, _depositId, _takers[i]);
        }
    }

    /**
     * @notice Checks if a taker is whitelisted for a specific deposit.
     *
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _taker       Taker address to check.
     */
    function isWhitelisted(address _escrow, uint256 _depositId, address _taker) external view returns (bool) {
        return whitelist[_escrow][_depositId][_taker];
    }

    /**
     * @inheritdoc IPreIntentHook
     */
    function validateSignalIntent(PreIntentContext calldata _ctx) external view override {
        if (msg.sender != orchestrator) revert UnauthorizedOrchestratorCaller(msg.sender);

        if (!whitelist[_ctx.escrow][_ctx.depositId][_ctx.taker]) {
            revert TakerNotWhitelisted(_ctx.taker, _ctx.escrow, _ctx.depositId);
        }
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
