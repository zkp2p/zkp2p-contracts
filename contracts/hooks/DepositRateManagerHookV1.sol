// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IDepositRateManagerHook } from "../interfaces/IDepositRateManagerHook.sol";
import { IBaseRateManagerRegistry } from "../interfaces/IBaseRateManagerRegistry.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";

/**
 * @title DepositRateManagerHookV1
 * @notice Shared, multi-tenant hook contract that enforces a per-rateManagerId minimum liquidity
 *         requirement for opting into delegated rate management.
 * @dev Escrow invokes onDepositOptIn before linking a deposit to a manager id.
 */
contract DepositRateManagerHookV1 is IDepositRateManagerHook {
    /* ============ Errors ============ */
    error InvalidRegistry(address registry);
    error NotManager(bytes32 rateManagerId, address caller, address manager);
    error BelowMinLiquidity(uint256 actual, uint256 required);

    /* ============ Events ============ */
    event MinLiquidityUpdated(address indexed registry, bytes32 indexed rateManagerId, uint256 minLiquidity);

    /* ============ State ============ */
    mapping(address => mapping(bytes32 => uint256)) public minLiquidity; // per (registry, rateManagerId) in deposit token units

    /**
     * @notice Sets the minimum liquidity required for a given manager id in a specific registry.
     * @dev Only callable by the manager recorded in that registry for this id.
     * @param registry      Rate manager registry address.
     * @param rateManagerId The rate manager id to configure.
     * @param min           The minimum total liquidity required to opt in (0 = no restriction).
     */
    function setMinLiquidity(address registry, bytes32 rateManagerId, uint256 min) external {
        if (registry == address(0)) revert InvalidRegistry(registry);
        IBaseRateManagerRegistry.RateManagerConfig memory cfg = IBaseRateManagerRegistry(registry).getRateManager(rateManagerId);
        if (cfg.manager != msg.sender) revert NotManager(rateManagerId, msg.sender, cfg.manager);
        minLiquidity[registry][rateManagerId] = min;
        emit MinLiquidityUpdated(registry, rateManagerId, min);
    }

    /**
     * @inheritdoc IDepositRateManagerHook
     */
    function onDepositOptIn(
        address depositor,
        address escrow,
        uint256 depositId,
        address registry,
        bytes32 rateManagerId
    )
        external
        view
        override
    {
        IEscrow.Deposit memory d = IEscrow(escrow).getDeposit(depositId);
        uint256 liq = d.remainingDeposits + d.outstandingIntentAmount;
        uint256 min = minLiquidity[registry][rateManagerId];
        if (min > 0 && liq < min) revert BelowMinLiquidity(liq, min);
        depositor; // silence unused var warning
    }
}
