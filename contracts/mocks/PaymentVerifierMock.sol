// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IPaymentVerifier } from "../interfaces/IPaymentVerifier.sol";
import { IPaymentEvidenceVerifier } from "../interfaces/IPaymentEvidenceVerifier.sol";
import { IOrchestrator } from "../interfaces/IOrchestrator.sol";
import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IEscrow } from "../interfaces/IEscrow.sol";

contract PaymentVerifierMock is IPaymentVerifier, IPaymentEvidenceVerifier {

    struct PaymentDetails {
        uint256 amount;
        uint256 timestamp;
        bytes32 payeeDetails;
        bytes32 fiatCurrency;
        bytes32 intentHash;
    }

    struct Snapshot {
        uint256 amount;
        uint256 conversionRate;
        uint256 signalTimestamp;
        bytes32 payeeDetails;
        bytes32 paymentMethod;
        bool found;
    }

    uint256 internal constant PRECISE_UNIT = 1e18;

    bool public shouldVerifyPayment;
    bool public shouldReturnFalse;
    address public orchestratorAddress;
    address public escrowAddress;
    mapping(address => mapping(bytes32 => bytes32)) internal verifiedPaymentDetailsHashes;

    function setShouldVerifyPayment(bool _shouldVerifyPayment) external {
        shouldVerifyPayment = _shouldVerifyPayment;
    }

    function setShouldReturnFalse(bool _shouldReturnFalse) external {
        shouldReturnFalse = _shouldReturnFalse;
    }

    function setVerificationContext(address _orchestrator, address _escrow) external {
        orchestratorAddress = _orchestrator;
        escrowAddress = _escrow;
    }

    function extractIntentHash(bytes calldata _proof) external pure returns (bytes32) {
        (, , , , bytes32 intentHash) = abi.decode(_proof, (uint256, uint256, bytes32, bytes32, bytes32));
        return intentHash;
    }

    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) external override returns (PaymentVerificationResult memory) {
        PaymentDetails memory paymentDetails = _extractPaymentDetails(_verifyPaymentData.paymentProof);

        Snapshot memory snapshot = _fetchSnapshot(paymentDetails.intentHash);

        if (shouldVerifyPayment) {
            require(snapshot.found, "UPV: Unknown intent");
            require(snapshot.conversionRate != 0, "UPV: Snapshot rate mismatch");
            require(
                snapshot.payeeDetails == bytes32(0) || paymentDetails.payeeDetails == snapshot.payeeDetails,
                "UPV: Snapshot payee mismatch"
            );
            if (snapshot.signalTimestamp != 0) {
                require(
                    paymentDetails.timestamp >= snapshot.signalTimestamp,
                    "UPV: Snapshot timestamp mismatch"
                );
            }
        }

        if (shouldReturnFalse) {
            return PaymentVerificationResult({
                success: false,
                intentHash: bytes32(0),
                releaseAmount: 0
            });
        }

        uint256 releaseAmount = paymentDetails.amount;
        if (snapshot.conversionRate > 0) {
            releaseAmount = (paymentDetails.amount * PRECISE_UNIT) / snapshot.conversionRate;
        }

        if (snapshot.amount > 0 && releaseAmount > snapshot.amount) {
            releaseAmount = snapshot.amount;
        }

        bytes32 paymentId = keccak256(abi.encodePacked("payment", paymentDetails.intentHash));
        verifiedPaymentDetailsHashes[msg.sender][paymentDetails.intentHash] = keccak256(abi.encode(
            snapshot.paymentMethod,
            paymentId,
            paymentDetails.amount,
            paymentDetails.fiatCurrency
        ));
        return PaymentVerificationResult({
            success: true,
            intentHash: paymentDetails.intentHash,
            releaseAmount: releaseAmount
        });
    }

    function getPaymentDetailsHash(
        address _orchestrator,
        bytes32 _intentHash
    ) external view override returns (bytes32) {
        return verifiedPaymentDetailsHashes[_orchestrator][_intentHash];
    }

    function _fetchSnapshot(bytes32 intentHash) internal view returns (Snapshot memory snapshot) {
        if (orchestratorAddress == address(0) || escrowAddress == address(0)) {
            return snapshot;
        }

        (bool isV2Orchestrator, ) = orchestratorAddress.staticcall(
            abi.encodeWithSelector(bytes4(keccak256("getDepositPreIntentHook(address,uint256)")), escrowAddress, 0)
        );

        if (isV2Orchestrator) {
            IOrchestratorV2.Intent memory intentDataV2 = IOrchestratorV2(orchestratorAddress).getIntent(intentHash);
            if (intentDataV2.owner == address(0)) {
                return snapshot;
            }

            IEscrow.DepositPaymentMethodData memory methodDataV2 = IEscrow(escrowAddress)
                .getDepositPaymentMethodData(intentDataV2.depositId, intentDataV2.paymentMethod);

            return Snapshot({
                amount: intentDataV2.amount,
                conversionRate: intentDataV2.conversionRate,
                signalTimestamp: intentDataV2.timestamp,
                payeeDetails: methodDataV2.payeeDetails,
                paymentMethod: intentDataV2.paymentMethod,
                found: true
            });
        }

        IOrchestrator.Intent memory intentData = IOrchestrator(orchestratorAddress).getIntent(intentHash);
        if (intentData.owner == address(0)) {
            return snapshot;
        }

        IEscrow.DepositPaymentMethodData memory methodData = IEscrow(escrowAddress)
            .getDepositPaymentMethodData(intentData.depositId, intentData.paymentMethod);

        return Snapshot({
            amount: intentData.amount,
            conversionRate: intentData.conversionRate,
            signalTimestamp: intentData.timestamp,
            payeeDetails: methodData.payeeDetails,
            paymentMethod: intentData.paymentMethod,
            found: true
        });
    }

    function _extractPaymentDetails(bytes calldata _proof) internal pure returns (PaymentDetails memory) {
        (uint256 amount, uint256 timestamp, bytes32 payeeDetails, bytes32 fiatCurrency, bytes32 intentHash) =
            abi.decode(_proof, (uint256, uint256, bytes32, bytes32, bytes32));

        return PaymentDetails(amount, timestamp, payeeDetails, fiatCurrency, intentHash);
    }
}
