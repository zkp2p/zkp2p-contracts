// SPDX-License-Identifier: MIT

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { DateParsing } from "../../lib/DateParsing.sol";
import { ClaimVerifier } from "../../lib/ClaimVerifier.sol";
import { StringConversionUtils } from "../../lib/StringConversionUtils.sol";

import { IBasePaymentVerifier } from "../interfaces/IBasePaymentVerifier.sol";
import { INullifierRegistry } from "../../interfaces/INullifierRegistry.sol";
import { IPaymentVerifier } from "../../interfaces/IPaymentVerifier.sol";

import { BaseReclaimVerifier } from "../BaseVerifiers/BaseReclaimVerifier.sol";

pragma solidity ^0.8.18;

contract ZelleCitiReclaimVerifier is IPaymentVerifier, BaseReclaimVerifier {

    using StringConversionUtils for string;
    
    /* ============ Structs ============ */

    // Struct to hold the payment details extracted from the proof
    struct PaymentDetails {
        string amountString;
        string transactionDate;
        string paymentId;
        string status;
        string partyToken;
        string intentHash;
        string providerHash;
    }

    /* ============ Constants ============ */
    
    uint8 internal constant MAX_EXTRACT_VALUES = 8; 
    uint8 internal constant MIN_WITNESS_SIGNATURE_REQUIRED = 1;
    bytes32 public constant DELIVERED_STATUS = keccak256(abi.encodePacked("DELIVERED"));

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
     * ONLY RAMP: Verifies a reclaim proof of an offchain Citi Zelle payment. Ensures the right _intentAmount * _conversionRate
     * USD was paid to _partyToken after _intentTimestamp + timestampBuffer on Citi Zelle.
     * Note: For Citi Zelle fiat currency is always USD. For other verifiers which support multiple currencies,
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
        _validateAndAddNullifier(keccak256(abi.encodePacked(paymentDetails.paymentId)));

        return IPaymentVerifier.PaymentVerificationResult({
            success: true,
            intentHash: bytes32(paymentDetails.intentHash.stringToUint(0)),
            releaseAmount: releaseAmount,
            paymentCurrency: _verifyPaymentData.fiatCurrency, // Zelle only supports USD
            paymentId: paymentDetails.paymentId
        });
    }

    /* ============ Internal Functions ============ */

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
            paymentDetails.partyToken.stringComparison(_verifyPaymentData.payeeDetails), 
            "Incorrect payment recipient"
        );

        // Validate timestamp; add in buffer to build flexibility for L2 timestamps
        // Append T23:59:59 to the date string to capture end of day because Zelle only shows day precision
        // Note: Citi date format is MM/DD/YYYY, need to convert to YYYY-MM-DD
        string memory formattedDate = _convertDateFormat(paymentDetails.transactionDate);
        uint256 paymentTimestamp = DateParsing._dateStringToTimestamp(
            string.concat(formattedDate, "T23:59:59")
        ) + timestampBuffer;
        require(paymentTimestamp >= _verifyPaymentData.intentTimestamp, "Incorrect payment timestamp");

        // Validate status
        require(
            keccak256(abi.encodePacked(paymentDetails.status)) == DELIVERED_STATUS,
            "Payment not delivered"
        );

        return paymentAmount;
    }

    function _decodeDepositData(bytes calldata _data) internal pure returns (address[] memory witnesses) {
        witnesses = abi.decode(_data, (address[]));
    }

    function _extractValues(ReclaimProof memory _proof) internal pure returns (PaymentDetails memory paymentDetails) {
        string[] memory values = ClaimVerifier.extractAllFromContext(
            _proof.claimInfo.context, 
            MAX_EXTRACT_VALUES, 
            true
        );

        return PaymentDetails({
            // values[0] is ContextAddress
            intentHash: values[1],
            amountString: values[2],
            partyToken: values[3],
            paymentId: values[4],
            status: values[5],
            transactionDate: values[6],
            providerHash: values[7]
        });
    }

    function _convertDateFormat(string memory mmddyyyy) internal pure returns (string memory) {
        // Convert MM/DD/YYYY to YYYY-MM-DD
        // Input format: "04/28/2025"
        // Output format: "2025-04-28"
        
        bytes memory dateBytes = bytes(mmddyyyy);
        require(dateBytes.length == 10, "Invalid date format");
        
        // Pre-allocate memory for the result
        bytes memory result = new bytes(10);
        
        // Copy year
        result[0] = dateBytes[6];
        result[1] = dateBytes[7];
        result[2] = dateBytes[8];
        result[3] = dateBytes[9];
        result[4] = '-';
        // Copy month
        result[5] = dateBytes[0];
        result[6] = dateBytes[1];
        result[7] = '-';
        // Copy day
        result[8] = dateBytes[3];
        result[9] = dateBytes[4];
        
        return string(result);
    }

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
