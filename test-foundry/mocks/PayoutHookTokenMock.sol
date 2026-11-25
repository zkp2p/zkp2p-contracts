// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ReentrantPayoutRecipientMock} from "./ReentrantPayoutRecipientMock.sol";

/// @notice Six-decimal token that calls a receiver hook after every transfer to the armed target, like an
/// ERC777-style token, so payout recipients can attempt re-entry mid-transfer.
contract PayoutHookTokenMock is ERC20 {
    address public hookTarget;

    constructor() ERC20("Hook USDC", "hUSDC") {
        _mint(msg.sender, 100_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setHookTarget(address _target) external {
        hookTarget = _target;
    }

    function _afterTokenTransfer(address, address _to, uint256 _amount) internal override {
        if (_to == hookTarget) ReentrantPayoutRecipientMock(_to).onTokenReceived(_amount);
    }
}
