// SPDX-License-Identifier: MIT

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { DateParsing } from "../../lib/DateParsing.sol";
import { ClaimVerifier } from "../../lib/ClaimVerifier.sol";
import { StringConversionUtils } from "../../lib/StringConversionUtils.sol";

import { IBasePaymentVerifier } from "../interfaces/IBasePaymentVerifier.sol";
import { BaseReclaimVerifier } from "../BaseVerifiers/BaseReclaimVerifier.sol";
import { INullifierRegistry } from "../../interfaces/INullifierRegistry.sol";
import { IPaymentVerifier } from "../../interfaces/IPaymentVerifier.sol";

pragma solidity ^0.8.18;


contract ZelleBoAReclaimVerifier is IPaymentVerifier, BaseReclaimVerifier {

    using StringConversionUtils for string;
    
    /* ============ Structs ============ */

    // Struct to hold the payment details extracted from the proof
    struct PaymentDetails {
        string amountString;
        string transactionDate;
        string confirmationNumber;
        string status;
        string aliasToken;
        string intentHash;
        string providerHash;
    }

    /* ============ Constants ============ */
    
    uint8 internal constant MAX_EXTRACT_VALUES = 8; 
    uint8 internal constant MIN_WITNESS_SIGNATURE_REQUIRED = 1;
    bytes32 public constant COMPLETED_STATUS = keccak256(abi.encodePacked("COMPLETED"));

    /* ============ State Variables ============ */
    address public immutable baseVerifier;
    INullifierRegistry public nullifierRegistry;
    uint256 public timestampBuffer;

    /* ============ Events ============ */
    event TimestampBufferSet(uint256 newTimestampBuffer);

    /* ============ Constructor ============ */
    constructor(
        address _baseVerifier,
        INullifierRegistry _nullifierRegistry,
        string[] memory _providerHashes,
        uint256 _timestampBuffer
    )   
        BaseReclaimVerifier(
            _providerHashes
        )
    {
        baseVerifier = _baseVerifier;
        nullifierRegistry = INullifierRegistry(_nullifierRegistry);
        timestampBuffer = _timestampBuffer;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY RAMP: Verifies a reclaim proof of an offchain Bank of America Zelle payment. Ensures the right _intentAmount * _conversionRate
     * USD was paid to _aliasToken after _intentTimestamp + timestampBuffer on Bank of America Zelle.
     * Note: For Bank of America Zelle fiat currency is always USD. For other verifiers which support multiple currencies,
     * _fiatCurrency needs to be checked against the fiat currency in the proof.
     *
     * @param _verifyPaymentData Payment proof and intent details required for verification
     * @return result The payment verification result containing success status, intent hash, release amount, payment currency and payment ID
     */
    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    )
        external 
        override
        returns (IPaymentVerifier.PaymentVerificationResult memory)
    {
        require(msg.sender == baseVerifier, "Only base verifier can call");

        PaymentDetails memory paymentDetails = _verifyProofAndExtractValues(_verifyPaymentData.paymentProof, _verifyPaymentData.depositData);
                
        uint256 paymentAmount = _verifyPaymentDetails(
            paymentDetails, 
            _verifyPaymentData
        );

        uint256 releaseAmount = _calculateReleaseAmount(
            paymentAmount, 
            _verifyPaymentData.conversionRate, 
            _verifyPaymentData.intentAmount
        );

        // Nullify the payment
        _validateAndAddNullifier(keccak256(abi.encodePacked(paymentDetails.confirmationNumber)));

        return IPaymentVerifier.PaymentVerificationResult({
            success: true,
            intentHash: bytes32(paymentDetails.intentHash.stringToUint(0)),
            releaseAmount: releaseAmount,
            paymentCurrency: _verifyPaymentData.fiatCurrency, // Zelle only supports USD
            paymentId: paymentDetails.confirmationNumber
        });
    }

    /* ============ Internal Functions ============ */

    /**
     * Verifies the proof and extracts the public values from the proof and _depositData.
     *
     * @param _proof The proof to verify.
     * @param _depositData The deposit data to extract the verification data from.
     */
    function _verifyProofAndExtractValues(bytes calldata _proof, bytes calldata _depositData) 
        internal
        view
        returns (PaymentDetails memory paymentDetails) 
    {
        // Decode proof
        ReclaimProof memory proof = abi.decode(_proof, (ReclaimProof));

        // Extract verification data
        address[] memory witnesses = _decodeDepositData(_depositData);

        verifyProofSignatures(proof, witnesses, MIN_WITNESS_SIGNATURE_REQUIRED);     // claim must have at least 1 signature from witnesses
        
        // Extract public values
        paymentDetails = _extractValues(proof);

        // Check provider hash (Required for Reclaim proofs)
        require(_validateProviderHash(paymentDetails.providerHash), "No valid providerHash");
    }

    /**
     * Verifies the right _intentAmount * _conversionRate is paid to hashed _aliasToken after 
     * _intentTimestamp + timestampBuffer on Zelle. Reverts if any of the conditions are not met.
     */
    function _verifyPaymentDetails(
        PaymentDetails memory paymentDetails,
        VerifyPaymentData memory _verifyPaymentData
    ) internal view returns (uint256) {
        uint8 decimals = IERC20Metadata(_verifyPaymentData.depositToken).decimals();

        // Validate amount
        uint256 paymentAmount = paymentDetails.amountString.stringToUint(decimals);
        require(paymentAmount > 0, "Payment amount must be greater than zero");
        
        // Validate recipient
        require(
            paymentDetails.aliasToken.stringComparison(_verifyPaymentData.payeeDetails), 
            "Incorrect payment recipient"
        );

        // Validate timestamp; add in buffer to build flexibility for L2 timestamps
        // Append T23:59:59 to the date string to capture end of day because Zelle only shows day precision
        uint256 paymentTimestamp = DateParsing._dateStringToTimestamp(
            string.concat(paymentDetails.transactionDate, "T23:59:59")
        ) + timestampBuffer;
        require(paymentTimestamp >= _verifyPaymentData.intentTimestamp, "Incorrect payment timestamp");

        // Validate status
        require(
            keccak256(abi.encodePacked(paymentDetails.status)) == COMPLETED_STATUS,
            "Payment not completed"
        );

        return paymentAmount;
    }

    /**
     * Extracts the verification data from the data. In case of a Reclaim/TLSN/ZK proof, data contains the witnesses' addresses.
     * In case of a zkEmail proof, data contains the DKIM key hash. Can also contain additional data like currency code, etc.
     *
     * @param _data The data to extract the verification data from.
     */
    function _decodeDepositData(bytes calldata _data) internal pure returns (address[] memory witnesses) {
        witnesses = abi.decode(_data, (address[]));
    }

    /**
     * Extracts all values from the proof context.
     *
     * @param _proof The proof containing the context to extract values from.
     */
    function _extractValues(ReclaimProof memory _proof) internal pure returns (PaymentDetails memory paymentDetails) {
        string[] memory values = ClaimVerifier.extractAllFromContext(
            _proof.claimInfo.context, 
            MAX_EXTRACT_VALUES, 
            true
        );

        return PaymentDetails({
            // values[0] is ContextAddress
            intentHash: values[1],
            aliasToken: values[2],
            amountString: values[3],
            confirmationNumber: values[4],
            status: values[5],
            transactionDate: values[6],
            providerHash: values[7]
        });
    }

    /* ============ Internal Functions ============ */

    function _validateAndAddNullifier(bytes32 _nullifier) internal {
        require(!nullifierRegistry.isNullified(_nullifier), "Nullifier has already been used");
        nullifierRegistry.addNullifier(_nullifier);
    }

    /* ============ Owner Functions ============ */

    /**
     * @notice OWNER ONLY: Sets the timestamp buffer for payments. This is the amount of time in seconds
     * that the timestamp can be off by and still be considered valid. Necessary to build in flexibility 
     * with L2 timestamps.
     *
     * @param _timestampBuffer    The timestamp buffer for payments
     */
    function setTimestampBuffer(uint256 _timestampBuffer) external onlyOwner {
        timestampBuffer = _timestampBuffer;
        emit TimestampBufferSet(_timestampBuffer);
    }
}
