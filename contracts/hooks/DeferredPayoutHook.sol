// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IDeferredPayoutHook } from "../interfaces/IDeferredPayoutHook.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IRiskManager } from "../interfaces/IRiskManager.sol";
import { IStakeVault } from "../interfaces/IStakeVault.sol";

/**
 * @title DeferredPayoutHook
 * @notice Moves fulfilled net proceeds directly from an authorized orchestrator into StakeVault.
 * @dev Tokens never pass through RiskManager. The transfer and risk accounting are atomic: if the
 *      manager rejects registration, the complete hook execution reverts.
 */
contract DeferredPayoutHook is IDeferredPayoutHook {
    using SafeERC20 for IERC20;

    /* ============ State Variables ============ */

    IERC20 public immutable payoutToken;
    IStakeVault public immutable stakeVault;
    IRiskManager public immutable riskManager;
    IOrchestratorRegistry public immutable orchestratorRegistry;

    /* ============ Errors ============ */

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedOrchestrator(address caller);
    error InvalidPayoutToken(address expected, address actual);

    /* ============ Constructor ============ */

    /**
     * @notice Creates the canonical deferred payout settlement action.
     * @param _payoutToken Token expected from fulfilled intents.
     * @param _stakeVault Vault receiving and holding deferred proceeds.
     * @param _riskManager Manager that owns deferred-position policy.
     * @param _orchestratorRegistry Registry of authorized orchestrators.
     */
    constructor(
        IERC20 _payoutToken,
        IStakeVault _stakeVault,
        IRiskManager _riskManager,
        IOrchestratorRegistry _orchestratorRegistry
    ) {
        if (
            address(_payoutToken) == address(0)
                || address(_stakeVault) == address(0)
                || address(_riskManager) == address(0)
                || address(_orchestratorRegistry) == address(0)
        ) {
            revert ZeroAddress();
        }
        address vaultToken = address(_stakeVault.stakeToken());
        if (address(_payoutToken) != vaultToken) {
            revert InvalidPayoutToken(vaultToken, address(_payoutToken));
        }

        payoutToken = _payoutToken;
        stakeVault = _stakeVault;
        riskManager = _riskManager;
        orchestratorRegistry = _orchestratorRegistry;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Deposits fulfilled net proceeds into StakeVault for the risk manager's deferred position.
     * @param _ctx Structured intent and executable-amount context from OrchestratorV3.
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata
    ) external override {
        address canonicalOrchestrator = address(riskManager.orchestrator());
        if (msg.sender != canonicalOrchestrator || !orchestratorRegistry.isOrchestrator(msg.sender)) {
            revert UnauthorizedOrchestrator(msg.sender);
        }
        if (_ctx.token != address(payoutToken)) revert InvalidPayoutToken(address(payoutToken), _ctx.token);
        if (_ctx.executableAmount == 0) revert ZeroAmount();

        payoutToken.safeTransferFrom(msg.sender, address(stakeVault), _ctx.executableAmount);
        riskManager.registerDeferredPayout(_ctx.intentHash, _ctx.intent.to, _ctx.executableAmount);

        emit PayoutDeferred(
            _ctx.intentHash,
            _ctx.intent.to,
            address(stakeVault),
            _ctx.executableAmount
        );
    }
}
