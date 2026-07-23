// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { IPostIntentHookV2 } from "../interfaces/IPostIntentHookV2.sol";

/**
 * @title PostIntentHookExecutor
 * @notice Transfers settled funds directly or executes a V2 post-intent hook with an exact allowance.
 * @dev This executor runs only after the risk hook declines gross-fund consumption and fees have been distributed.
 *      Without a hook, it transfers the executable amount directly to the snapshotted intent recipient. With a hook, it
 *      grants a temporary exact allowance and requires the orchestrator's token balance to decrease by precisely that
 *      amount during execution. The complete settlement reverts on hook failure or any other balance delta.
 */
library PostIntentHookExecutor {
    using SafeERC20 for IERC20;

    /**
     * @notice Transfers `_netAmount` to the recipient or requires the configured hook to consume it exactly.
     * @dev The hook receives immutable signal-time intent context plus fulfillment-time execution data. Its allowance is
     *      reset before being granted and cleared after exact-consumption validation. A revert at any stage atomically
     *      unwinds the allowance and all earlier settlement transfers.
     * @param _token Settlement token held by OrchestratorV3.
     * @param _intentHash Identifier supplied to the post-intent hook execution context.
     * @param _intent Snapshotted intent containing recipient, hook address, and signal-time context.
     * @param _netAmount Executable amount remaining after all ordinary settlement fees.
     * @param _postIntentHookData Fulfillment-time opaque data forwarded to the hook.
     * @return fundsTransferredTo Direct recipient when no hook is set, otherwise the hook that consumed the funds.
     */
    function transferOrExecute(
        IERC20 _token,
        bytes32 _intentHash,
        IOrchestratorV3.Intent memory _intent,
        uint256 _netAmount,
        bytes memory _postIntentHookData
    ) public returns (address fundsTransferredTo) {
        if (address(_intent.postIntentHook) == address(0)) {
            _token.safeTransfer(_intent.to, _netAmount);
            return _intent.to;
        }

        uint256 preBalance = _token.balanceOf(address(this));
        _token.safeApprove(address(_intent.postIntentHook), 0);
        _token.safeApprove(address(_intent.postIntentHook), _netAmount);

        _intent.postIntentHook.execute(
            IPostIntentHookV2.HookExecutionContext({
                intentHash: _intentHash,
                token: address(_token),
                executableAmount: _netAmount,
                intent: IPostIntentHookV2.HookIntentContext({
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
            _postIntentHookData
        );

        uint256 postBalance = _token.balanceOf(address(this));
        require(postBalance <= preBalance, "PostIntentHook: unexpected balance increase");
        require(preBalance - postBalance == _netAmount, "PostIntentHook: must pull exact netAmount");

        _token.safeApprove(address(_intent.postIntentHook), 0);
        return address(_intent.postIntentHook);
    }
}
