// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IERC4626
 * @notice Minimal ERC-4626 tokenized vault interface used by ERC4626VaultHookV2.
 * @dev Only the methods the hook actually calls are declared. Vaults that conform to
 *      EIP-4626 (https://eips.ethereum.org/EIPS/eip-4626) expose the full surface.
 */
interface IERC4626 {
    /**
     * @notice Returns the address of the underlying asset token managed by the vault.
     */
    function asset() external view returns (address);

    /**
     * @notice Simulates the effects of a deposit at the current block, returning the
     *         number of shares that would be minted for `assets`.
     * @dev Per spec, MUST return as close to and no more than the exact amount of shares
     *      that would actually be minted, making it a safe upper-bound slippage gate.
     * @param assets The amount of underlying asset to simulate depositing
     * @return shares The number of vault shares that would be minted
     */
    function previewDeposit(uint256 assets) external view returns (uint256 shares);

    /**
     * @notice Mints vault shares to `receiver` by depositing exactly `assets` of the underlying token.
     * @param assets The amount of underlying asset to deposit
     * @param receiver The address to receive the minted shares
     * @return shares The number of vault shares minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
}
