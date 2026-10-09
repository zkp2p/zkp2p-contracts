// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

/**
 * @title IPaymentValidationHook
 * @notice Applies additional payment rules after the verifier authenticates the intent and signed data.
 */
interface IPaymentValidationHook {
    /**
     * @notice Reverts when the verified payment does not satisfy the hook's rules.
     * @dev The caller verifies the signature and binds the data to the intent before calling this hook.
     * @param _intentHash Verified intent hash.
     * @param _data Complete signed payment data.
     * @param _hookData Hook configuration saved in the canonical intent at admission.
     */
    function validatePayment(bytes32 _intentHash, bytes calldata _data, bytes calldata _hookData) external view;
}
