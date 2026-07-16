// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { ISettlementHook } from "../interfaces/ISettlementHook.sol";

/**
 * @title SettlementHookExecutor
 * @notice Transfers settled funds directly or executes a settlement hook with an exact allowance.
 */
library SettlementHookExecutor {
    using SafeERC20 for IERC20;

    /**
     * @notice Transfers `_netAmount` to the recipient or requires the configured hook to consume it exactly.
     * @return fundsTransferredTo Recipient of the direct transfer or the hook that consumed the funds.
     */
    function transferOrExecute(
        IERC20 _token,
        bytes32 _intentHash,
        IOrchestratorV2.Intent memory _intent,
        uint256 _netAmount,
        bytes memory _settlementHookData
    ) public returns (address fundsTransferredTo) {
        if (address(_intent.settlementHook) == address(0)) {
            _token.safeTransfer(_intent.to, _netAmount);
            return _intent.to;
        }

        uint256 preBalance = _token.balanceOf(address(this));
        _token.safeApprove(address(_intent.settlementHook), 0);
        _token.safeApprove(address(_intent.settlementHook), _netAmount);

        _intent.settlementHook.execute(
            ISettlementHook.HookExecutionContext({
                intentHash: _intentHash,
                token: address(_token),
                executableAmount: _netAmount,
                intent: ISettlementHook.HookIntentContext({
                    owner: _intent.owner,
                    to: _intent.to,
                    escrow: _intent.escrow,
                    depositId: _intent.depositId,
                    amount: _intent.amount,
                    timestamp: _intent.timestamp,
                    paymentMethod: _intent.paymentMethod,
                    fiatCurrency: _intent.fiatCurrency,
                    conversionRate: _intent.conversionRate,
                    payeeId: _intent.payeeId,
                    signalHookData: _intent.data
                })
            }),
            _settlementHookData
        );

        uint256 postBalance = _token.balanceOf(address(this));
        require(postBalance <= preBalance, "SettlementHook: unexpected balance increase");
        require(preBalance - postBalance == _netAmount, "SettlementHook: must pull exact netAmount");

        _token.safeApprove(address(_intent.settlementHook), 0);
        return address(_intent.settlementHook);
    }
}
