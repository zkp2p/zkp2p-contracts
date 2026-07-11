// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test, Vm} from "forge-std/Test.sol";

import {UnifiedPaymentVerifier} from "../../contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {IAttestationVerifier} from "../../contracts/interfaces/IAttestationVerifier.sol";
import {IEscrow} from "../../contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "../../contracts/interfaces/IOrchestrator.sol";
import {IPaymentVerifier} from "../../contracts/interfaces/IPaymentVerifier.sol";
import {IPostIntentHook} from "../../contracts/interfaces/IPostIntentHook.sol";
import {NullifierRegistry} from "../../contracts/registries/NullifierRegistry.sol";
import {OrchestratorRegistry} from "../../contracts/registries/OrchestratorRegistry.sol";

contract AcceptingAttestationVerifier is IAttestationVerifier {
    function verify(bytes32, bytes[] calldata, bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract UnifiedPaymentVerifierCallerMock {
    IOrchestrator.Intent private intent;

    function setIntent(IOrchestrator.Intent memory newIntent) external {
        intent = newIntent;
    }

    function getIntent(bytes32) external view returns (IOrchestrator.Intent memory) {
        return intent;
    }

    function callVerifyPayment(UnifiedPaymentVerifier verifier, bytes32 intentHash, bytes memory paymentProof)
        external
        returns (IPaymentVerifier.PaymentVerificationResult memory result)
    {
        result = verifier.verifyPayment(
            IPaymentVerifier.VerifyPaymentData({intentHash: intentHash, paymentProof: paymentProof, data: ""})
        );
    }
}

contract UnifiedPaymentVerifierReleaseClassificationUnit is Test {
    bytes32 private constant INTENT_HASH = keccak256("intent");
    bytes32 private constant PAYMENT_METHOD = keccak256("venmo");
    bytes32 private constant FIAT_CURRENCY = keccak256("USD");
    bytes32 private constant PAYEE_ID = keccak256("payee");
    bytes32 private constant PAYMENT_ID = keccak256("payment");
    bytes32 private constant SAR_MARKER = keccak256("zkp2p.sar.v1");

    uint256 private constant INTENT_AMOUNT = 100e6;
    uint256 private constant RELEASE_AMOUNT = 80e6;
    uint256 private constant PAYMENT_AMOUNT = 10_000;
    uint256 private constant PAYMENT_TIMESTAMP = 1_710_000_000_000;
    uint256 private constant CONVERSION_RATE = 1e18;
    uint256 private constant SIGNAL_TIMESTAMP = 1_700_000_000;

    UnifiedPaymentVerifier private verifier;
    UnifiedPaymentVerifierCallerMock private verifierCaller;

    function setUp() public {
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        NullifierRegistry nullifierRegistry = new NullifierRegistry();
        AcceptingAttestationVerifier attestationVerifier = new AcceptingAttestationVerifier();

        verifier = new UnifiedPaymentVerifier(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        verifierCaller = new UnifiedPaymentVerifierCallerMock();

        orchestratorRegistry.addOrchestrator(address(verifierCaller));
        nullifierRegistry.addWritePermission(address(verifier));
        verifier.addPaymentMethod(PAYMENT_METHOD);
        verifierCaller.setIntent(_defaultIntent());

        IEscrow.DepositPaymentMethodData memory depositPaymentMethodData =
            IEscrow.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE_ID, data: ""});
        vm.mockCall(
            address(0x1003),
            abi.encodeWithSelector(IEscrow.getDepositPaymentMethodData.selector, uint256(1), PAYMENT_METHOD),
            abi.encode(depositPaymentMethodData)
        );
    }

    function test_verifyPayment_emitsSellerAutomatedReleaseTrueForSarMarker() public {
        _verifyAndAssertReleaseClassification(abi.encode(SAR_MARKER), true);
    }

    function test_verifyPayment_emitsSellerAutomatedReleaseFalseForNonSarMarker() public {
        _verifyAndAssertReleaseClassification(abi.encode(keccak256("zkp2p.not-sar.v1")), false);
    }

    function test_verifyPayment_emitsSellerAutomatedReleaseFalseForEmptyMetadata() public {
        _verifyAndAssertReleaseClassification("", false);
    }

    function _verifyAndAssertReleaseClassification(bytes memory metadata, bool expectedSellerAutomatedRelease)
        internal
    {
        vm.recordLogs();

        IPaymentVerifier.PaymentVerificationResult memory result =
            verifierCaller.callVerifyPayment(verifier, INTENT_HASH, _paymentProof(metadata));

        assertTrue(result.success);
        assertEq(result.intentHash, INTENT_HASH);
        assertEq(result.releaseAmount, RELEASE_AMOUNT);
        _assertReleaseClassificationLog(expectedSellerAutomatedRelease);
    }

    function _assertReleaseClassificationLog(bool expectedSellerAutomatedRelease) internal {
        Vm.Log[] memory recordedLogs = vm.getRecordedLogs();
        bytes32 eventSignature = keccak256("PaymentReleaseClassified(bytes32,bool)");
        uint256 matchingLogCount;

        for (uint256 logIndex = 0; logIndex < recordedLogs.length; logIndex++) {
            if (
                recordedLogs[logIndex].emitter == address(verifier) && recordedLogs[logIndex].topics.length == 2
                    && recordedLogs[logIndex].topics[0] == eventSignature
            ) {
                matchingLogCount++;
                assertEq(recordedLogs[logIndex].topics[1], INTENT_HASH);
                assertEq(abi.decode(recordedLogs[logIndex].data, (bool)), expectedSellerAutomatedRelease);
            }
        }

        assertEq(matchingLogCount, 1, "classification log count");
    }

    function _paymentProof(bytes memory metadata) internal pure returns (bytes memory) {
        UnifiedPaymentVerifier.PaymentDetails memory paymentDetails = UnifiedPaymentVerifier.PaymentDetails({
            method: PAYMENT_METHOD,
            payeeId: PAYEE_ID,
            amount: PAYMENT_AMOUNT,
            currency: FIAT_CURRENCY,
            timestamp: PAYMENT_TIMESTAMP,
            paymentId: PAYMENT_ID
        });

        UnifiedPaymentVerifier.IntentSnapshot memory intentSnapshot = UnifiedPaymentVerifier.IntentSnapshot({
            intentHash: INTENT_HASH,
            amount: INTENT_AMOUNT,
            paymentMethod: PAYMENT_METHOD,
            fiatCurrency: FIAT_CURRENCY,
            payeeDetails: PAYEE_ID,
            conversionRate: CONVERSION_RATE,
            signalTimestamp: SIGNAL_TIMESTAMP,
            timestampBuffer: 0
        });

        bytes memory paymentData = abi.encode(paymentDetails, intentSnapshot);
        bytes[] memory signatures = new bytes[](0);

        UnifiedPaymentVerifier.PaymentAttestation memory attestation = UnifiedPaymentVerifier.PaymentAttestation({
            intentHash: INTENT_HASH,
            releaseAmount: RELEASE_AMOUNT,
            dataHash: keccak256(paymentData),
            signatures: signatures,
            data: paymentData,
            metadata: metadata
        });

        return abi.encode(attestation);
    }

    function _defaultIntent() internal pure returns (IOrchestrator.Intent memory) {
        return IOrchestrator.Intent({
            owner: address(0x1001),
            to: address(0x1002),
            escrow: address(0x1003),
            depositId: 1,
            amount: INTENT_AMOUNT,
            timestamp: SIGNAL_TIMESTAMP,
            paymentMethod: PAYMENT_METHOD,
            fiatCurrency: FIAT_CURRENCY,
            conversionRate: CONVERSION_RATE,
            payeeId: PAYEE_ID,
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: ""
        });
    }
}
