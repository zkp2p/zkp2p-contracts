// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title IRateManager
 * @notice Minimal interface implemented by delegated rate manager contracts.
 */
interface IRateManager {
    /**
     * @notice Returns the effective rate for a delegated deposit.
     * @dev Returns 0 when the tuple is disabled or not configured.
     * @param _rateManagerId Manager identifier within the rate manager contract.
     * @param _escrow Escrow contract address that owns the deposit.
     * @param _depositId Deposit identifier on the escrow.
     * @param _paymentMethod Payment method key.
     * @param _currencyCode Fiat currency key.
     * @return rate Effective minimum conversion rate in precise units.
     */
    function getRate(
        bytes32 _rateManagerId,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod,
        bytes32 _currencyCode
    ) external view returns (uint256 rate);

    /**
     * @notice Returns fee terms for a delegated rate manager id.
     * @param _rateManagerId Manager identifier within the rate manager contract.
     * @return recipient Fee recipient address.
     * @return fee Fee amount in precise units (1e16 = 1%).
     */
    function getFee(bytes32 _rateManagerId) external view returns (address recipient, uint256 fee);

    /**
     * @notice Checks whether a manager id exists.
     * @param _rateManagerId Manager identifier to check.
     * @return exists True when the manager id exists.
     */
    function isRateManager(bytes32 _rateManagerId) external view returns (bool exists);

    /**
     * @notice Called by EscrowV2 when a depositor opts into delegation.
     * @dev Only callable by whitlisted escrow contracts. Implementations should use msg.sender as the
     *      escrow address. May revert to reject opt-in.
     * @param _depositId Deposit identifier.
     * @param _rateManagerId Manager identifier being opted into.
     */
    function onDepositOptIn(
        uint256 _depositId,
        bytes32 _rateManagerId
    ) external;
}
