// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Six-decimal token that, like USDC, refuses any transfer to or from a blacklisted account.
contract BlacklistTokenMock is ERC20 {
    mapping(address => bool) public isBlacklisted;

    constructor() ERC20("Blacklist USDC", "bUSDC") {
        _mint(msg.sender, 10_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setBlacklisted(address _account, bool _blacklisted) external {
        isBlacklisted[_account] = _blacklisted;
    }

    function _beforeTokenTransfer(address _from, address _to, uint256) internal view override {
        require(!isBlacklisted[_from] && !isBlacklisted[_to], "Blacklistable: account is blacklisted");
    }
}
