//SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { PaymentSplitter } from "@openzeppelin/contracts/finance/PaymentSplitter.sol";

/**
 * @title ReferralFeeSplitter
 * @notice Periphery contract for splitting received referral (referrer) fees among multiple recipients.
 *
 *         ZKP2P's `Orchestrator` pays the referrer by doing an ERC20 `safeTransfer` to `intent.referrer`.
 *         If `intent.referrer` is set to an instance of this contract, the transferred tokens will be
 *         held here and can be withdrawn by the configured payees according to their share weights.
 *
 *         This contract uses OpenZeppelin's `PaymentSplitter` pull-payment model:
 *         - Any address can send ETH or ERC20 tokens to this contract.
 *         - Each payee can independently withdraw their pro-rata share at any time via `release`.
 *         - Shares/payees are immutable after deployment (redeploy to change recipients).
 *
 *         IMPORTANT: The ZKP2P protocol currently pays referrer fees in ERC20 tokens; ETH support is
 *         included for completeness.
 */
contract ReferralFeeSplitter is PaymentSplitter {
    constructor(
        address[] memory _payees,
        uint256[] memory _shares
    )
        payable
        PaymentSplitter(_payees, _shares)
    {}
}

