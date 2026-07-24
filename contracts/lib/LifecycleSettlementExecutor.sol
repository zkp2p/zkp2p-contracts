// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IIntentLifecycleHook } from "../interfaces/IIntentLifecycleHook.sol";
import { BoundedCall } from "./BoundedCall.sol";

/**
 * @title LifecycleSettlementExecutor
 * @notice Enforces the temporary-allowance and exact balance-delta boundary for post-Escrow lifecycle settlement.
 * @dev A lifecycle hook receives an allowance for the gross release only during its fail-closed callback. After the callback,
 *      the allowance is removed and OrchestratorV3's token balance must have decreased by either zero or exactly the gross
 *      amount. Zero selects ordinary fee and recipient distribution; full consumption delegates all downstream accounting
 *      to the lifecycle hook. Partial consumption and balance increases always revert the complete settlement.
 */
library LifecycleSettlementExecutor {
    using SafeERC20 for IERC20;

    event IntentSettlementExecuted(
        bytes32 indexed intentHash,
        address indexed lifecycleHook,
        address indexed token,
        uint256 grossAmount,
        uint256 executableAmount,
        bool fundsConsumed,
        bool isManualRelease
    );

    error InvalidLifecycleHook(address hook);
    error LifecycleHookSettlementBalanceIncreased(bytes32 intentHash, uint256 beforeBalance, uint256 afterBalance);
    error InvalidLifecycleHookSettlementConsumption(bytes32 intentHash, uint256 consumed, uint256 grossAmount);

    /**
     * @notice Gives a validated lifecycle hook temporary access to gross funds and classifies its exact balance consumption.
     * @dev A zero hook is treated as zero consumption without granting an allowance. A non-zero hook must contain deployed
     *      code. Its existing allowance is cleared, the gross allowance is granted, and `BoundedCall` executes settlement
     *      fail-closed. The allowance is cleared again before balance-delta validation. Any revert unwinds every allowance
     *      and accounting change atomically.
     * @param _lifecycleHook Snapshotted lifecycle hook, or zero to select ordinary settlement.
     * @param _token Settlement token held by OrchestratorV3.
     * @param _context Exact intent, token, recipient, gross amount, executable amount, fee plan, and release type.
     * @param _gasLimit Exact gas allowance forwarded to the lifecycle callback.
     * @param _maxReturnDataSize Maximum return or revert data copied from the lifecycle callback.
     * @return fundsConsumed Whether the hook consumed the exact gross amount before ordinary distribution.
     */
    function execute(
        IIntentLifecycleHook _lifecycleHook,
        IERC20 _token,
        IIntentLifecycleHook.SettlementContext memory _context,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public returns (bool fundsConsumed) {
        address lifecycleHookAddress = address(_lifecycleHook);
        if (lifecycleHookAddress == address(0)) {
            emit IntentSettlementExecuted(
                _context.intentHash,
                address(0),
                address(_token),
                _context.grossAmount,
                _context.executableAmount,
                false,
                _context.isManualRelease
            );
            return false;
        }
        if (lifecycleHookAddress.code.length == 0) revert InvalidLifecycleHook(lifecycleHookAddress);

        uint256 balanceBefore = _token.balanceOf(address(this));
        _token.safeApprove(lifecycleHookAddress, 0);
        _token.safeApprove(lifecycleHookAddress, _context.grossAmount);

        BoundedCall.executeLifecycleSettlement(_lifecycleHook, _context, _gasLimit, _maxReturnDataSize);

        _token.safeApprove(lifecycleHookAddress, 0);
        uint256 balanceAfter = _token.balanceOf(address(this));
        if (balanceAfter > balanceBefore) {
            revert LifecycleHookSettlementBalanceIncreased(_context.intentHash, balanceBefore, balanceAfter);
        }

        uint256 consumedAmount = balanceBefore - balanceAfter;
        if (consumedAmount != 0 && consumedAmount != _context.grossAmount) {
            revert InvalidLifecycleHookSettlementConsumption(
                _context.intentHash,
                consumedAmount,
                _context.grossAmount
            );
        }
        fundsConsumed = consumedAmount == _context.grossAmount;

        emit IntentSettlementExecuted(
            _context.intentHash,
            lifecycleHookAddress,
            address(_token),
            _context.grossAmount,
            _context.executableAmount,
            fundsConsumed,
            _context.isManualRelease
        );
    }
}
