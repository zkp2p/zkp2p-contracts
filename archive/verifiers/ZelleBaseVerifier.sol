// SPDX-License-Identifier: MIT

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { DateParsing } from "../lib/DateParsing.sol";
import { ClaimVerifier } from "../lib/ClaimVerifier.sol";
import { StringConversionUtils } from "../lib/StringConversionUtils.sol";
import { Bytes32ConversionUtils } from "../lib/Bytes32ConversionUtils.sol";

import { BasePaymentVerifier } from "./BaseVerifiers/BasePaymentVerifier.sol";
import { INullifierRegistry } from "../interfaces/INullifierRegistry.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IReclaimVerifier } from "./interfaces/IReclaimVerifier.sol";

pragma solidity ^0.8.18;

/*
 * @notice ZelleBaseVerifier is a base contract for verifying Zelle payments. The Zelle payment method is a 
 * collection of different payment methods, each with their own verification logic. This verifier is added 
 * to Escrow by sellers who want to receive Zelle payments. It manages currencies (only USD) and payment method 
 * to verifier mappings and DELEGATES VERIFICATION to the appropriate verifier based on the payment method.
 */
contract ZelleBaseVerifier is IPaymentVerifier, BasePaymentVerifier {

    /* ============ Events ============ */  
    
    event PaymentMethodVerifierSet(uint8 paymentMethod, address verifier);
    event PaymentMethodVerifierRemoved(uint8 paymentMethod);

    /* ============ State Variables ============ */
    
    mapping(uint8 => address) public paymentMethodToVerifier;
    
    /* ============ Constructor ============ */
    constructor(
        address _escrow,
        INullifierRegistry _nullifierRegistry,
        uint256 _timestampBuffer,
        bytes32[] memory _currencies
    )   
        BasePaymentVerifier(
            _escrow, 
            _nullifierRegistry, 
            _timestampBuffer, 
            _currencies
        )
    { }

    /* ============ External Functions ============ */

    /**
     * ONLY RAMP: Verifies a reclaim proof of an offchain Zelle payment. Because Zelle supports multiple payment methods 
     * (each with their own verification logic), the _verifyPaymentData.paymentProof field should contain the payment method.
     * Payment method should be encodePacked with the payment proof. We chose this over encoding it as (uint8, bytes) because
     * computation is cheaper on L2 than calldata.
     *
     * @param _verifyPaymentData Payment proof, intent details, and payment method required for verification
     * @return result The payment verification result containing success status, intent hash, release amount, payment currency and payment ID
     */
    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    )
        external
        override
        returns (IPaymentVerifier.PaymentVerificationResult memory)
    {
        require(msg.sender == escrow, "Only escrow can call");

        bytes calldata rawPaymentProofFromCalldata = _verifyPaymentData.paymentProof;
        require(rawPaymentProofFromCalldata.length > 1, "Invalid paymentProof length");

        // Extract the first byte as paymentMethod directly from calldata
        uint8 paymentMethod = uint8(rawPaymentProofFromCalldata[0]);

        // Use calldata array slicing [start:end] syntax - NO copying needed!
        // This creates a view/reference to the original data, avoiding gas-expensive copying
        bytes calldata actualProofSlice = rawPaymentProofFromCalldata[1:];

        address verifier = paymentMethodToVerifier[paymentMethod];
        require(verifier != address(0), "Verifier not set");

        return IPaymentVerifier(verifier).verifyPayment(
            IPaymentVerifier.VerifyPaymentData({
                paymentProof: actualProofSlice,
                depositToken: _verifyPaymentData.depositToken,
                intentAmount: _verifyPaymentData.intentAmount,
                intentTimestamp: _verifyPaymentData.intentTimestamp,
                payeeDetails: _verifyPaymentData.payeeDetails,
                fiatCurrency: _verifyPaymentData.fiatCurrency,
                conversionRate: _verifyPaymentData.conversionRate,
                depositData: _verifyPaymentData.depositData,
                data: bytes("")
            })
        );
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice ONLY OWNER: Sets the verifier for a payment method.
     * @param _paymentMethod The payment method to set the verifier for.
     * @param _verifier The address of the verifier to set.
     */
    function setPaymentMethodVerifier(uint8 _paymentMethod, address _verifier) external onlyOwner {
        require(_verifier != address(0), "Invalid verifier address");

        paymentMethodToVerifier[_paymentMethod] = _verifier;
        emit PaymentMethodVerifierSet(_paymentMethod, _verifier);
    }

    /**
     * @notice ONLY OWNER: Removes the verifier for a payment method.
     * @param _paymentMethod The payment method to remove the verifier for.
     */
    function removePaymentMethodVerifier(uint8 _paymentMethod) external onlyOwner {
        require(paymentMethodToVerifier[_paymentMethod] != address(0), "Verifier not set");

        delete paymentMethodToVerifier[_paymentMethod];
        emit PaymentMethodVerifierRemoved(_paymentMethod);
    }    
}
