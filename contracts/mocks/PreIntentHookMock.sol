// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";

contract PreIntentHookMock is IPreIntentHook {
    bool public shouldRevert;
    uint256 public callCount;

    address public lastTaker;
    address public lastEscrow;
    uint256 public lastDepositId;
    uint256 public lastAmount;
    address public lastTo;
    bytes32 public lastPaymentMethod;
    bytes32 public lastFiatCurrency;
    uint256 public lastConversionRate;
    address public lastReferrer;
    uint256 public lastReferrerFee;
    bytes public lastPreIntentHookData;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function validateSignalIntent(PreIntentContext calldata _ctx) external override {
        if (shouldRevert) {
            revert("PreIntentHookMock: rejected");
        }

        callCount += 1;
        lastTaker = _ctx.taker;
        lastEscrow = _ctx.escrow;
        lastDepositId = _ctx.depositId;
        lastAmount = _ctx.amount;
        lastTo = _ctx.to;
        lastPaymentMethod = _ctx.paymentMethod;
        lastFiatCurrency = _ctx.fiatCurrency;
        lastConversionRate = _ctx.conversionRate;
        lastReferrer = _ctx.referrer;
        lastReferrerFee = _ctx.referrerFee;
        lastPreIntentHookData = _ctx.preIntentHookData;
    }
}
