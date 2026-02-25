// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IPreIntentHook } from "./IPreIntentHook.sol";

/**
 * @title ISignatureGatingPreIntentHook
 * @notice Interface for the signature-based pre-intent hook with per-deposit signer configuration.
 */
interface ISignatureGatingPreIntentHook is IPreIntentHook {
    event DepositSignerSet(
        address indexed escrow,
        uint256 indexed depositId,
        address indexed signer,
        address setter
    );

    /**
     * @notice Sets or clears the authorized signer for a deposit.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     * @param _signer Authorized signer (address(0) clears signer).
     */
    function setDepositSigner(address _escrow, uint256 _depositId, address _signer) external;

    /**
     * @notice Returns configured signer for a deposit.
     * @param _escrow Escrow address.
     * @param _depositId Deposit id.
     */
    function getDepositSigner(address _escrow, uint256 _depositId) external view returns (address);
}
