// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IIntentLifecycleHook } from "../interfaces/IIntentLifecycleHook.sol";
import { BoundedCall } from "./BoundedCall.sol";

/**
 * @title RiskSettlementExecutor
 * @notice Enforces the temporary-allowance and exact balance-delta boundary for post-Escrow risk settlement.
 * @dev A risk hook receives an allowance for the gross release only during its fail-closed callback. After the callback,
 *      the allowance is removed and OrchestratorV3's token balance must have decreased by either zero or exactly the gross
 *      amount. Zero selects ordinary fee and recipient distribution; full consumption delegates all downstream accounting
 *      to the risk hook. Partial consumption and balance increases always revert the complete settlement.
 */
library RiskSettlementExecutor {
    using SafeERC20 for IERC20;

    event IntentRiskSettlementExecuted(
        bytes32 indexed intentHash,
        address indexed riskHook,
        address indexed token,
        uint256 grossAmount,
        uint256 executableAmount,
        bool fundsConsumed,
        bool isManualRelease
    );

    error InvalidRiskHook(address hook);
    error RiskHookSettlementBalanceIncreased(bytes32 intentHash, uint256 beforeBalance, uint256 afterBalance);
    error InvalidRiskHookSettlementConsumption(bytes32 intentHash, uint256 consumed, uint256 grossAmount);

    /**
     * @notice Gives a validated risk hook temporary access to gross funds and classifies its exact balance consumption.
     * @dev A zero hook is treated as zero consumption without granting an allowance. A non-zero hook must contain deployed
     *      code. Its existing allowance is cleared, the gross allowance is granted, and `BoundedCall` executes settlement
     *      fail-closed. The allowance is cleared again before balance-delta validation. Any revert unwinds every allowance
     *      and accounting change atomically.
     * @param _riskHook Snapshotted risk hook, or zero to select ordinary settlement.
     * @param _token Settlement token held by OrchestratorV3.
     * @param _context Exact intent, token, recipient, gross amount, executable amount, fee plan, and release type.
     * @param _gasLimit Exact gas allowance forwarded to the risk callback.
     * @param _maxReturnDataSize Maximum return or revert data copied from the risk callback.
     * @return fundsConsumed Whether the hook consumed the exact gross amount before ordinary distribution.
     */
    function execute(
        IIntentLifecycleHook _riskHook,
        IERC20 _token,
        IIntentLifecycleHook.RiskSettlementContext memory _context,
        uint256 _gasLimit,
        uint256 _maxReturnDataSize
    ) public returns (bool fundsConsumed) {
        address riskHookAddress = address(_riskHook);
        if (riskHookAddress == address(0)) {
            emit IntentRiskSettlementExecuted(
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
        if (riskHookAddress.code.length == 0) revert InvalidRiskHook(riskHookAddress);

        uint256 balanceBefore = _token.balanceOf(address(this));
        _token.safeApprove(riskHookAddress, 0);
        _token.safeApprove(riskHookAddress, _context.grossAmount);

        BoundedCall.executeRiskSettlement(_riskHook, _context, _gasLimit, _maxReturnDataSize);

        _token.safeApprove(riskHookAddress, 0);
        uint256 balanceAfter = _token.balanceOf(address(this));
        if (balanceAfter > balanceBefore) {
            revert RiskHookSettlementBalanceIncreased(_context.intentHash, balanceBefore, balanceAfter);
        }

        uint256 consumedAmount = balanceBefore - balanceAfter;
        if (consumedAmount != 0 && consumedAmount != _context.grossAmount) {
            revert InvalidRiskHookSettlementConsumption(
                _context.intentHash,
                consumedAmount,
                _context.grossAmount
            );
        }
        fundsConsumed = consumedAmount == _context.grossAmount;

        emit IntentRiskSettlementExecuted(
            _context.intentHash,
            riskHookAddress,
            address(_token),
            _context.grossAmount,
            _context.executableAmount,
            fundsConsumed,
            _context.isManualRelease
        );
    }
}
