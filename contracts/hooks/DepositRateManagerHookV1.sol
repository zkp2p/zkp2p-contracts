// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IDepositRateManagerHook } from "../interfaces/IDepositRateManagerHook.sol";
import { IDepositRateManagerRegistryV1 } from "../interfaces/IDepositRateManagerRegistryV1.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";

/**
 * @title DepositRateManagerHookV1
 * @notice Shared, multi-tenant hook contract that enforces a per-rateManagerId minimum liquidity
 *         requirement for opting into delegated rate management.
 * @dev Escrow invokes onDepositOptIn before linking a deposit to a manager id.
 */
contract DepositRateManagerHookV1 is IDepositRateManagerHook {
    /* ============ Errors ============ */
    error NotManager(bytes32 rateManagerId, address caller, address manager);
    error BelowMinLiquidity(uint256 actual, uint256 required);

    /* ============ Events ============ */
    event MinLiquidityUpdated(bytes32 indexed rateManagerId, uint256 minLiquidity);

    /* ============ State ============ */
    IDepositRateManagerRegistryV1 public immutable registry;
    mapping(bytes32 => uint256) public minLiquidity; // per rateManagerId (in deposit token units)

    constructor(address _registry) {
        require(_registry != address(0), "Invalid registry");
        registry = IDepositRateManagerRegistryV1(_registry);
    }

    /**
     * @notice Sets the minimum liquidity required for a given manager id.
     * @dev Only callable by the manager recorded in the registry for this id.
     * @param rateManagerId The rate manager id to configure.
     * @param min           The minimum total liquidity required to opt in (0 = no restriction).
     */
    function setMinLiquidity(bytes32 rateManagerId, uint256 min) external {
        IDepositRateManagerRegistryV1.RateManagerConfig memory cfg = registry.getRateManager(rateManagerId);
        if (cfg.manager != msg.sender) revert NotManager(rateManagerId, msg.sender, cfg.manager);
        minLiquidity[rateManagerId] = min;
        emit MinLiquidityUpdated(rateManagerId, min);
    }

    /**
     * @inheritdoc IDepositRateManagerHook
     */
    function onDepositOptIn(address depositor, address escrow, uint256 depositId, bytes32 rateManagerId) external view override {
        IEscrow.Deposit memory d = IEscrow(escrow).getDeposit(depositId);
        uint256 liq = d.remainingDeposits + d.outstandingIntentAmount;
        uint256 min = minLiquidity[rateManagerId];
        if (min > 0 && liq < min) revert BelowMinLiquidity(liq, min);
        depositor; // silence unused var warning
    }
}

