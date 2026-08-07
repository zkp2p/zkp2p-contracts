// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ERC4626Mock is ERC4626 {
    using SafeERC20 for IERC20;

    bool public isPreviewWithdrawReverting;

    constructor(IERC20 _asset) ERC20("USDC Yield Vault", "yvUSDC") ERC4626(_asset) {}

    function setPreviewWithdrawReverting(bool _isReverting) external {
        isPreviewWithdrawReverting = _isReverting;
    }

    function removeAssets(address _recipient, uint256 _amount) external {
        IERC20(asset()).safeTransfer(_recipient, _amount);
    }

    function previewWithdraw(uint256 _assets) public view override returns (uint256 shares) {
        require(!isPreviewWithdrawReverting, "ERC4626Mock: preview unavailable");
        return super.previewWithdraw(_assets);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }
}
