// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Bytes32ArrayUtils } from "../external/Bytes32ArrayUtils.sol";
import { IAttestationVerifier } from "../interfaces/IAttestationVerifier.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";
import { INullifierRegistry } from "../interfaces/INullifierRegistry.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";

/**
 * @title BaseUnifiedPaymentVerifier
 * @notice Base contract for unified payment verification that manages configuration for multiple payment methods.
 *
 * This contract handles:
 * - Supported payment methods
 * - Attestation verification through pluggable attestation verifiers
 *
 * @dev This is an abstract contract that must be inherited by concrete implementations.
 *      It replaces the previous BaseReclaimVerifier with a more flexible architecture.
 */
abstract contract BaseUnifiedPaymentVerifier is Ownable {

    using Bytes32ArrayUtils for bytes32[];

    /* ============ Constants ============ */

    uint256 internal constant PRECISE_UNIT = 1e18;

    uint256 private constant MAX_TIMESTAMP_BUFFER = 48 * 60 * 60 * 1000;

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant PAYMENT_ATTESTATION_TYPEHASH = keccak256(
        "PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"
    );

    bytes4 private constant GET_DEPOSIT_PRE_INTENT_HOOK_SELECTOR =
        bytes4(keccak256("getDepositPreIntentHook(address,uint256)"));

    /* ============ Events ============ */

    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    /* ============ Structs ============ */

    struct PaymentDetails {
        bytes32 method;
        bytes32 payeeId;
        uint256 amount;
        bytes32 currency;
        uint256 timestamp;
        bytes32 paymentId;
    }

    struct IntentSnapshot {
        bytes32 intentHash;
        uint256 amount;
        bytes32 paymentMethod;
        bytes32 fiatCurrency;
        bytes32 payeeDetails;
        uint256 conversionRate;
        uint256 signalTimestamp;
        uint256 timestampBuffer;
    }

    struct PaymentAttestation {
        bytes32 intentHash;
        uint256 releaseAmount;
        bytes32 dataHash;
        bytes[] signatures;
        bytes data;
        bytes metadata;
    }

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    INullifierRegistry public immutable nullifierRegistry;
    bytes32 public immutable DOMAIN_SEPARATOR;
    IAttestationVerifier public attestationVerifier;

    bytes32[] public paymentMethods;
    mapping(bytes32 => bool) public isPaymentMethod;

    /* ============ Modifiers ============ */

    /**
     * Modifier to ensure only an authorized orchestrator can call.
     */
    modifier onlyOrchestrator() {
        require(orchestratorRegistry.isOrchestrator(msg.sender), "Only orchestrator can call");
        _;
    }

    /* ============ Constructor ============ */

    /**
     * @notice Initializes base payment verifier
     * @param _orchestratorRegistry The orchestrator registry contract that authorizes orchestrators
     * @param _nullifierRegistry The nullifier registry contract that will be used to prevent double-spends
     * @param _attestationVerifier The attestation verifier contract that will be used to verify attestation by the
     * offchain / ZK attestation service
     */
    constructor(
        IOrchestratorRegistry _orchestratorRegistry,
        INullifierRegistry _nullifierRegistry,
        IAttestationVerifier _attestationVerifier
    ) Ownable() {
        orchestratorRegistry = _orchestratorRegistry;
        nullifierRegistry = _nullifierRegistry;
        attestationVerifier = _attestationVerifier;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("UnifiedPaymentVerifier")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Adds a new payment method with timestamp buffer
     * @param _paymentMethod The payment method hash; Hash the payment method name in lowercase
     */
    function addPaymentMethod(bytes32 _paymentMethod) external onlyOwner {
        require(!isPaymentMethod[_paymentMethod], "UPV: Payment method already exists");

        isPaymentMethod[_paymentMethod] = true;
        paymentMethods.push(_paymentMethod);

        emit PaymentMethodAdded(_paymentMethod);
    }

    /**
     * ONLY OWNER: Removes a payment method and associated configuration
     * @param _paymentMethod The payment method to remove
     */
    function removePaymentMethod(bytes32 _paymentMethod) external onlyOwner {
        require(isPaymentMethod[_paymentMethod], "UPV: Payment method does not exist");

        delete isPaymentMethod[_paymentMethod];
        paymentMethods.removeStorage(_paymentMethod);

        emit PaymentMethodRemoved(_paymentMethod);
    }

    /**
     * @notice Updates the attestation verifier contract
     * @param _newVerifier The new attestation verifier address
     */
    function setAttestationVerifier(address _newVerifier) external onlyOwner {
        address oldVerifier = address(attestationVerifier);
        require(_newVerifier != address(0), "UPV: Invalid attestation verifier");
        require(_newVerifier != oldVerifier, "UPV: Same verifier");

        attestationVerifier = IAttestationVerifier(_newVerifier);
        emit AttestationVerifierUpdated(oldVerifier, _newVerifier);
    }

    /* ============ View Functions ============ */

    function getPaymentMethods() external view returns (bytes32[] memory) {
        return paymentMethods;
    }

    /* ============ Internal Functions ============ */

    /**
     * Validates and adds a nullifier to prevent double-spending
     * @param _nullifier The nullifier to add
     */
    function _validateAndAddNullifier(bytes32 _nullifier) internal {
        require(!nullifierRegistry.isNullified(_nullifier), "Nullifier has already been used");
        nullifierRegistry.addNullifier(_nullifier);
    }

    /**
     * @dev Verifies one payment attestation and returns only values authenticated by that attestation.
     *      Thin ABI wrappers decide whether to expose the payment identifier to their caller.
     */
    function _verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) internal returns (bytes32 intentHash, uint256 releaseAmount, bytes32 paymentId) {
        PaymentAttestation memory attestation = abi.decode(
            _verifyPaymentData.paymentProof,
            (PaymentAttestation)
        );
        (PaymentDetails memory paymentDetails, IntentSnapshot memory intentSnapshot) =
            abi.decode(attestation.data, (PaymentDetails, IntentSnapshot));

        require(isPaymentMethod[paymentDetails.method], "UPV: Invalid payment method");
        require(paymentDetails.amount != 0, "UPV: Invalid payment amount");
        require(paymentDetails.currency != bytes32(0), "UPV: Invalid payment currency");

        _validateIntentSnapshot(_verifyPaymentData.intentHash, intentSnapshot);
        require(_verifyAttestation(attestation), "UPV: Invalid attestation");

        _nullifyPayment(paymentDetails.method, paymentDetails.paymentId);
        _emitPaymentDetails(attestation.intentHash, paymentDetails);

        return (
            attestation.intentHash,
            _calculateReleaseAmount(attestation.releaseAmount, intentSnapshot.amount),
            paymentDetails.paymentId
        );
    }

    function _verifyAttestation(PaymentAttestation memory _attestation) internal view returns (bool) {
        bytes32 structHash = keccak256(
            abi.encode(
                PAYMENT_ATTESTATION_TYPEHASH,
                _attestation.intentHash,
                _attestation.releaseAmount,
                _attestation.dataHash
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        require(keccak256(_attestation.data) == _attestation.dataHash, "UPV: Data hash mismatch");
        return attestationVerifier.verify(digest, _attestation.signatures, _attestation.data);
    }

    function _validateIntentSnapshot(
        bytes32 _intentHash,
        IntentSnapshot memory _snapshot
    ) internal view {
        require(_snapshot.intentHash == _intentHash, "UPV: Snapshot hash mismatch");

        if (_isV2Orchestrator(msg.sender)) {
            IOrchestratorV2.Intent memory intentV2 = IOrchestratorV2(msg.sender).getIntent(_intentHash);
            _validateSnapshotAgainstIntent(
                _snapshot,
                intentV2.payeeId,
                intentV2.amount,
                intentV2.paymentMethod,
                intentV2.fiatCurrency,
                intentV2.conversionRate,
                intentV2.timestamp
            );
        } else {
            IOrchestrator.Intent memory intent = IOrchestrator(msg.sender).getIntent(_intentHash);
            _validateSnapshotAgainstIntent(
                _snapshot,
                intent.payeeId,
                intent.amount,
                intent.paymentMethod,
                intent.fiatCurrency,
                intent.conversionRate,
                intent.timestamp
            );
        }

        require(
            _snapshot.timestampBuffer <= MAX_TIMESTAMP_BUFFER,
            "UPV: Snapshot timestamp buffer exceeds maximum"
        );
    }

    function _validateSnapshotAgainstIntent(
        IntentSnapshot memory _snapshot,
        bytes32 _payeeId,
        uint256 _amount,
        bytes32 _paymentMethod,
        bytes32 _fiatCurrency,
        uint256 _conversionRate,
        uint256 _signalTimestamp
    ) internal pure {
        require(_snapshot.payeeDetails == _payeeId, "UPV: Snapshot payee mismatch");
        require(_snapshot.amount == _amount, "UPV: Snapshot amount mismatch");
        require(_snapshot.paymentMethod == _paymentMethod, "UPV: Snapshot method mismatch");
        require(_snapshot.fiatCurrency == _fiatCurrency, "UPV: Snapshot currency mismatch");
        require(_snapshot.conversionRate == _conversionRate, "UPV: Snapshot rate mismatch");
        require(_snapshot.signalTimestamp == _signalTimestamp, "UPV: Snapshot timestamp mismatch");
    }

    function _isV2Orchestrator(address _orchestrator) internal view returns (bool isV2Orchestrator) {
        (isV2Orchestrator, ) = _orchestrator.staticcall(
            abi.encodeWithSelector(GET_DEPOSIT_PRE_INTENT_HOOK_SELECTOR, address(0), 0)
        );
    }

    function _nullifyPayment(bytes32 _paymentMethod, bytes32 _paymentId) internal {
        require(_paymentId != bytes32(0), "UPV: Invalid payment ID");
        _validateAndAddNullifier(keccak256(abi.encodePacked(_paymentMethod, _paymentId)));
    }

    function _calculateReleaseAmount(
        uint256 _releaseAmount,
        uint256 _intentAmount
    ) internal pure returns (uint256) {
        return _releaseAmount > _intentAmount ? _intentAmount : _releaseAmount;
    }

    function _emitPaymentDetails(bytes32 _intentHash, PaymentDetails memory _paymentDetails) internal {
        emit PaymentVerified(
            _intentHash,
            _paymentDetails.method,
            _paymentDetails.currency,
            _paymentDetails.amount,
            _paymentDetails.timestamp,
            _paymentDetails.paymentId,
            _paymentDetails.payeeId
        );
    }
}
