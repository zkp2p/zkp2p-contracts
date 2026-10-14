// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IPaymentVerifierV2 } from "contracts/interfaces/IPaymentVerifierV2.sol";
import { IPaymentVerifier } from "contracts/interfaces/IPaymentVerifier.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IOrchestratorV2 } from "contracts/interfaces/IOrchestratorV2.sol";
import { IEscrow } from "contracts/interfaces/IEscrow.sol";

contract PaymentVerifierV2Mock is IPaymentVerifierV2 {

    struct MockPaymentDetails {
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
        bool found;
    }

    uint256 internal constant PRECISE_UNIT = 1e18;

    bool public balanceFunded;

    /// @notice Configures the signed balance flag returned by the mock.
    function setBalanceFunded(bool _balanceFunded) external {
        balanceFunded = _balanceFunded;
    }

    bool public shouldVerifyPayment;
    bool public shouldReturnFalse;
    address public orchestratorAddress;
    address public escrowAddress;

    /// @notice Configures proof snapshot validation.
    function setShouldVerifyPayment(bool _shouldVerifyPayment) external {
        shouldVerifyPayment = _shouldVerifyPayment;
    }

    /// @notice Configures a failed verification result.
    function setShouldReturnFalse(bool _shouldReturnFalse) external {
        shouldReturnFalse = _shouldReturnFalse;
    }

    /// @notice Sets the orchestrator and escrow used to read the intent snapshot.
    function setVerificationContext(address _orchestrator, address _escrow) external {
        orchestratorAddress = _orchestrator;
        escrowAddress = _escrow;
    }

    /// @notice Extracts the intent hash from a mock payment proof.
    function extractIntentHash(bytes calldata _proof) external pure returns (bytes32) {
        (, , , , bytes32 intentHash) = abi.decode(_proof, (uint256, uint256, bytes32, bytes32, bytes32));
        return intentHash;
    }

    /// @notice Verifies a mock proof and returns the capped release and balance flag.
    function verifyPayment(
        IPaymentVerifier.VerifyPaymentData calldata _verifyPaymentData
    ) external view override returns (PaymentVerificationResultV2 memory result, bytes memory extensionData) {
        MockPaymentDetails memory paymentDetails = _extractMockPaymentDetails(_verifyPaymentData.paymentProof);

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
            result.balanceFunded = balanceFunded;
            return (result, "");
        }

        uint256 releaseAmount = paymentDetails.amount;
        if (snapshot.conversionRate > 0) {
            releaseAmount = (paymentDetails.amount * PRECISE_UNIT) / snapshot.conversionRate;
        }

        if (snapshot.amount > 0 && releaseAmount > snapshot.amount) {
            releaseAmount = snapshot.amount;
        }

        result.success = true;
        result.intentHash = paymentDetails.intentHash;
        result.releaseAmount = releaseAmount;
        result.balanceFunded = balanceFunded;
        return (result, "");
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
            found: true
        });
    }

    function _extractMockPaymentDetails(bytes calldata _proof) internal pure returns (MockPaymentDetails memory) {
        (uint256 amount, uint256 timestamp, bytes32 payeeDetails, bytes32 fiatCurrency, bytes32 intentHash) =
            abi.decode(_proof, (uint256, uint256, bytes32, bytes32, bytes32));

        return MockPaymentDetails(amount, timestamp, payeeDetails, fiatCurrency, intentHash);
    }
}
