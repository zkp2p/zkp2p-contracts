// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IERC4626 } from "../external/Interfaces/IERC4626.sol";

/**
 * @title ERC4626VaultMock
 * @notice Minimal configurable ERC-4626 vault used by ERC4626VaultHookV2 unit tests.
 * @dev Supports toggling reverts on previewDeposit and deposit, custom share rates, and an
 *      override that mints fewer shares than previewDeposit reports (for non-compliance tests).
 */
contract ERC4626VaultMock is ERC20, IERC4626 {
    using SafeERC20 for IERC20;

    error MockPreviewRevert();
    error MockDepositRevert();

    IERC20 private immutable _asset;
    uint8 private immutable _assetDecimals;

    /// @notice Numerator for shares-per-asset rate (default 1).
    uint256 public sharesPerAssetNumerator = 1;
    /// @notice Denominator for shares-per-asset rate (default 1).
    uint256 public sharesPerAssetDenominator = 1;

    bool public previewShouldRevert;
    bool public depositShouldRevert;
    /// @notice If non-zero, the actual shares minted equal `forcedActualShares` regardless of preview.
    uint256 public forcedActualShares;
    /// @notice If true, the vault keeps any allowance unused (does not pull funds).
    bool public skipAssetPull;

    constructor(IERC20 asset_, uint8 assetDecimals_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {
        _asset = asset_;
        _assetDecimals = assetDecimals_;
    }

    function decimals() public view override returns (uint8) {
        return _assetDecimals;
    }

    /* ============ Mock Configuration ============ */

    function setSharesPerAsset(uint256 numerator, uint256 denominator) external {
        require(denominator != 0, "denominator zero");
        sharesPerAssetNumerator = numerator;
        sharesPerAssetDenominator = denominator;
    }

    function setPreviewShouldRevert(bool value) external {
        previewShouldRevert = value;
    }

    function setDepositShouldRevert(bool value) external {
        depositShouldRevert = value;
    }

    function setForcedActualShares(uint256 value) external {
        forcedActualShares = value;
    }

    function setSkipAssetPull(bool value) external {
        skipAssetPull = value;
    }

    /* ============ ERC-4626 ============ */

    function asset() external view override returns (address) {
        return address(_asset);
    }

    function previewDeposit(uint256 assets) public view override returns (uint256) {
        if (previewShouldRevert) revert MockPreviewRevert();
        return (assets * sharesPerAssetNumerator) / sharesPerAssetDenominator;
    }

    function deposit(uint256 assets, address receiver) external override returns (uint256) {
        if (depositShouldRevert) revert MockDepositRevert();

        if (!skipAssetPull) {
            _asset.safeTransferFrom(msg.sender, address(this), assets);
        }

        uint256 sharesToMint = forcedActualShares != 0
            ? forcedActualShares
            : (assets * sharesPerAssetNumerator) / sharesPerAssetDenominator;

        _mint(receiver, sharesToMint);
        return sharesToMint;
    }
}
