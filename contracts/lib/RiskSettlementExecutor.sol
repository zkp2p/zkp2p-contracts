// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IIntentRiskHook } from "../interfaces/IIntentRiskHook.sol";
import { BoundedCall } from "./BoundedCall.sol";

/** @notice Exact temporary-allowance and balance-delta boundary for post-funds risk settlement. */
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

    /** @return fundsConsumed Whether the hook consumed the exact gross amount before distribution. */
    function execute(
        IIntentRiskHook _riskHook,
        IERC20 _token,
        IIntentRiskHook.RiskSettlementContext memory _context,
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
