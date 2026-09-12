// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3CallerHarness} from "contracts/mocks/UnifiedPaymentVerifierV3Harness.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPaymentVerifier} from "contracts/interfaces/IPaymentVerifier.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {UnifiedVerifierV2CallerHarness} from "./UnifiedPaymentVerifierV3.t.sol";

contract UnifiedPaymentVerifierV4Test is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant AMOUNT = 50e6;
    uint256 internal constant TIMESTAMP = 1_000_000;
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant BALANCE = keccak256("venmo-balance");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant PAYMENT = keccak256("canonical-venmo-payment");
    bytes32 internal constant FIRST_INTENT = keccak256("first-intent");
    bytes32 internal constant SECOND_INTENT = keccak256("second-intent");

    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal registry;
    OrchestratorRegistry internal orchestrators;
    SimpleAttestationVerifier internal attestor;
    UnifiedPaymentVerifierV4 internal verifier;
    UnifiedPaymentVerifierV3CallerHarness internal firstCaller;
    UnifiedVerifierV2CallerHarness internal secondCaller;

    function setUp() public {
        vm.warp(TIMESTAMP);
        legacyRegistry = new NullifierRegistry();
        registry = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        orchestrators = new OrchestratorRegistry();
        attestor = new SimpleAttestationVerifier(vm.addr(WITNESS_KEY));
        verifier = new UnifiedPaymentVerifierV4(orchestrators, registry, attestor);
        firstCaller = new UnifiedPaymentVerifierV3CallerHarness();
        secondCaller = new UnifiedVerifierV2CallerHarness();
        orchestrators.addOrchestrator(address(firstCaller));
        orchestrators.addOrchestrator(address(secondCaller));
        registry.addWritePermission(address(verifier));
        legacyRegistry.addWritePermission(address(this));
        verifier.addPaymentMethod(VENMO, VENMO);
        verifier.addPaymentMethod(BALANCE, VENMO);
        verifier.addPaymentMethod(PAYPAL, PAYPAL);
    }

    function test_ExplicitNamespacesAndStableActiveMethodOrder() public view {
        bytes32[] memory methods = verifier.getPaymentMethods();
        assertEq(methods.length, 3);
        assertEq(methods[0], VENMO);
        assertEq(methods[1], BALANCE);
        assertEq(methods[2], PAYPAL);
        assertEq(verifier.nullifierNamespace(VENMO), VENMO);
        assertEq(verifier.nullifierNamespace(BALANCE), VENMO);
        assertEq(verifier.nullifierNamespace(PAYPAL), PAYPAL);
    }

    function test_RegistrationRejectsZeroValuesAndUnauthorizedCallers() public {
        bytes32 fresh = keccak256("fresh");
        vm.expectRevert("UPV: Invalid payment method");
        verifier.addPaymentMethod(bytes32(0), VENMO);
        vm.expectRevert("UPV: Invalid nullifier namespace");
        verifier.addPaymentMethod(fresh, bytes32(0));
        vm.prank(makeAddr("outsider"));
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.addPaymentMethod(fresh, fresh);
        assertFalse(verifier.isPaymentMethod(fresh));
        assertEq(verifier.nullifierNamespace(fresh), bytes32(0));
    }

    function test_DisableRetainsNamespaceAndReactivationCannotChangeIt() public {
        vm.expectRevert("UPV: Payment method already exists");
        verifier.addPaymentMethod(BALANCE, VENMO);
        vm.prank(makeAddr("outsider"));
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.removePaymentMethod(BALANCE);
        verifier.removePaymentMethod(BALANCE);
        assertFalse(verifier.isPaymentMethod(BALANCE));
        assertEq(verifier.nullifierNamespace(BALANCE), VENMO);
        vm.expectRevert("UPV: Nullifier namespace mismatch");
        verifier.addPaymentMethod(BALANCE, BALANCE);
        verifier.addPaymentMethod(BALANCE, VENMO);
        assertTrue(verifier.isPaymentMethod(BALANCE));
        assertEq(verifier.nullifierNamespace(BALANCE), VENMO);
    }

    function test_NamespaceIsFinalNotARecursiveAlias() public {
        bytes32 method = keccak256("alias");
        verifier.addPaymentMethod(method, BALANCE);
        _setFirstIntent(method);
        _firstVerify(verifier, method, PAYMENT);
        assertTrue(registry.isNullified(keccak256(abi.encodePacked(BALANCE, PAYMENT))));
        assertFalse(registry.isNullified(_venmoNullifier(PAYMENT)));
    }

    function test_RegularThenBalanceRejectsFreshProofFromAnotherOrchestrator() public {
        _assertCrossMethodReplay(VENMO, BALANCE);
    }

    function test_BalanceThenRegularRejectsFreshProofFromAnotherOrchestrator() public {
        _assertCrossMethodReplay(BALANCE, VENMO);
    }

    function test_ReattestationWithDifferentAmountAndCurrencyCannotResetConsumption() public {
        _setFirstIntent(VENMO);
        _firstVerify(verifier, VENMO, PAYMENT);
        bytes32 eur = keccak256("EUR");
        _setSecondIntent(BALANCE, 100e6, eur);
        bytes memory proof = _proof(SECOND_INTENT, BALANCE, PAYMENT, verifier.DOMAIN_SEPARATOR(), 100e6, eur);
        vm.expectRevert("Nullifier has already been used");
        secondCaller.verifyPayment(verifier, _verifyData(SECOND_INTENT, proof));
        assertEq(registry.intentHashByNullifier(_venmoNullifier(PAYMENT)), FIRST_INTENT);
    }

    function test_PredecessorHistoryRejectsBothMethods() public {
        legacyRegistry.addNullifier(_venmoNullifier(PAYMENT));
        _setFirstIntent(BALANCE);
        bytes memory proof = _proof(FIRST_INTENT, BALANCE, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("Nullifier has already been used");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
        _setFirstIntent(VENMO);
        proof = _proof(FIRST_INTENT, VENMO, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("Nullifier has already been used");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
    }

    function test_V3HistorySurvivesVerifierReplacement() public {
        UnifiedPaymentVerifierV3 previous = new UnifiedPaymentVerifierV3(orchestrators, registry, attestor);
        previous.addPaymentMethod(VENMO);
        registry.addWritePermission(address(previous));
        _setFirstIntent(VENMO);
        bytes memory proof = _proof(FIRST_INTENT, VENMO, PAYMENT, previous.DOMAIN_SEPARATOR(), AMOUNT, USD);
        firstCaller.verifyPayment(previous, _verifyData(FIRST_INTENT, proof));
        registry.removeWritePermission(address(previous));
        _setSecondIntent(BALANCE, AMOUNT, USD);
        proof = _proof(SECOND_INTENT, BALANCE, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("Nullifier has already been used");
        secondCaller.verifyPayment(verifier, _verifyData(SECOND_INTENT, proof));
    }

    function test_ReactivationCannotReopenConsumedPayments() public {
        _setFirstIntent(BALANCE);
        _firstVerify(verifier, BALANCE, PAYMENT);
        verifier.removePaymentMethod(BALANCE);
        verifier.addPaymentMethod(BALANCE, VENMO);
        _setSecondIntent(BALANCE, AMOUNT, USD);
        bytes memory proof = _proof(SECOND_INTENT, BALANCE, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("Nullifier has already been used");
        secondCaller.verifyPayment(verifier, _verifyData(SECOND_INTENT, proof));
    }

    function test_UnregisteredAndDisabledMethodsCannotConsume() public {
        bytes32 unknown = keccak256("unknown");
        _setFirstIntent(unknown);
        bytes memory proof = _proof(FIRST_INTENT, unknown, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("UPV: Invalid payment method");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
        verifier.removePaymentMethod(BALANCE);
        _setFirstIntent(BALANCE);
        proof = _proof(FIRST_INTENT, BALANCE, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("UPV: Invalid payment method");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
        assertFalse(registry.isNullified(_venmoNullifier(PAYMENT)));
    }

    function test_DistinctPaymentsAndProviderNamespacesRemainIndependent() public {
        _setFirstIntent(BALANCE);
        _firstVerify(verifier, BALANCE, PAYMENT);
        _setSecondIntent(VENMO, AMOUNT, USD);
        bytes32 different = keccak256("different-payment");
        bytes memory proof = _proof(SECOND_INTENT, VENMO, different, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        secondCaller.verifyPayment(verifier, _verifyData(SECOND_INTENT, proof));
        assertTrue(registry.isNullified(_venmoNullifier(different)));

        // A separate registry binding is still required even when the opaque provider ID matches.
        bytes32 thirdIntent = keccak256("third-intent");
        IOrchestrator.Intent memory intent = firstCaller.getIntent(FIRST_INTENT);
        intent.paymentMethod = PAYPAL;
        firstCaller.setIntent(thirdIntent, intent);
        proof = _proof(thirdIntent, PAYPAL, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        firstCaller.verifyPayment(verifier, _verifyData(thirdIntent, proof));
        assertTrue(registry.isNullified(keccak256(abi.encodePacked(PAYPAL, PAYMENT))));
        assertEq(registry.intentHashByNullifier(_venmoNullifier(PAYMENT)), FIRST_INTENT);
    }

    function test_ExistingIntentBindingCannotBeOverwritten() public {
        _setFirstIntent(BALANCE);
        _firstVerify(verifier, BALANCE, PAYMENT);
        bytes memory proof =
            _proof(FIRST_INTENT, BALANCE, keccak256("new-payment"), verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert(
            abi.encodeWithSelector(
                INullifierRegistryV2.IntentAlreadyBound.selector, FIRST_INTENT, _venmoNullifier(PAYMENT)
            )
        );
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
    }

    function test_EventPreservesActualBalanceMethodAndPayloadIs448Bytes() public {
        _setFirstIntent(BALANCE);
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(FIRST_INTENT, BALANCE, USD, AMOUNT, TIMESTAMP * 1000, PAYMENT, PAYEE);
        _firstVerify(verifier, BALANCE, PAYMENT);
        assertEq(_payload(FIRST_INTENT, BALANCE, PAYMENT, AMOUNT, USD).length, 448);
    }

    function test_RegularPayloadMatchesV3ByteForByte() public pure {
        bytes memory previous = abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(VENMO, PAYEE, AMOUNT, USD, TIMESTAMP * 1000, PAYMENT),
            UnifiedPaymentVerifierV3.IntentSnapshot(FIRST_INTENT, AMOUNT, VENMO, USD, PAYEE, 1e18, TIMESTAMP, 60)
        );
        assertEq(_payload(FIRST_INTENT, VENMO, PAYMENT, AMOUNT, USD), previous);
    }

    function test_OldDomainSignatureAndRelabeledMethodRejectBeforeConsumption() public {
        _setFirstIntent(BALANCE);
        UnifiedPaymentVerifierV3 previous = new UnifiedPaymentVerifierV3(orchestrators, registry, attestor);
        bytes memory proof = _proof(FIRST_INTENT, BALANCE, PAYMENT, previous.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));

        proof = _proof(FIRST_INTENT, VENMO, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        UnifiedPaymentVerifierV4.PaymentAttestation memory attestation =
            abi.decode(proof, (UnifiedPaymentVerifierV4.PaymentAttestation));
        attestation.data = _payload(FIRST_INTENT, BALANCE, PAYMENT, AMOUNT, USD);
        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert("ThresholdSigVerifierUtils: Not enough valid witness signatures");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, abi.encode(attestation)));
        assertFalse(registry.isNullified(_venmoNullifier(PAYMENT)));
    }

    function test_RegularProofCannotFulfillBalanceIntent() public {
        _setFirstIntent(BALANCE);
        bytes memory proof = _proof(FIRST_INTENT, VENMO, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("UPV: Snapshot method mismatch");
        firstCaller.verifyPayment(verifier, _verifyData(FIRST_INTENT, proof));
    }

    function _assertCrossMethodReplay(bytes32 firstMethod, bytes32 secondMethod) internal {
        _setFirstIntent(firstMethod);
        _firstVerify(verifier, firstMethod, PAYMENT);
        _setSecondIntent(secondMethod, AMOUNT, USD);
        bytes memory proof = _proof(SECOND_INTENT, secondMethod, PAYMENT, verifier.DOMAIN_SEPARATOR(), AMOUNT, USD);
        vm.expectRevert("Nullifier has already been used");
        secondCaller.verifyPayment(verifier, _verifyData(SECOND_INTENT, proof));
        assertEq(registry.intentHashByNullifier(_venmoNullifier(PAYMENT)), FIRST_INTENT);
        assertEq(registry.nullifierByIntentHash(SECOND_INTENT), bytes32(0));
    }

    function _setFirstIntent(bytes32 method) internal {
        firstCaller.setIntent(
            FIRST_INTENT,
            IOrchestrator.Intent({
                owner: address(this),
                to: address(this),
                escrow: address(0xEC),
                depositId: 0,
                amount: AMOUNT,
                timestamp: TIMESTAMP,
                paymentMethod: method,
                fiatCurrency: USD,
                conversionRate: 1e18,
                payeeId: PAYEE,
                referrer: address(0),
                referrerFee: 0,
                postIntentHook: IPostIntentHook(address(0)),
                data: ""
            })
        );
    }

    function _setSecondIntent(bytes32 method, uint256 amount, bytes32 currency) internal {
        secondCaller.setIntent(
            SECOND_INTENT,
            IOrchestratorV2.Intent({
                owner: address(this),
                to: address(this),
                escrow: address(0xEC),
                depositId: 0,
                amount: amount,
                timestamp: TIMESTAMP,
                paymentMethod: method,
                fiatCurrency: currency,
                conversionRate: 1e18,
                payeeId: PAYEE,
                referralFees: new IReferralFee.ReferralFee[](0),
                postIntentHook: IPostIntentHookV2(address(0)),
                data: ""
            })
        );
    }

    function _payload(bytes32 intentHash, bytes32 method, bytes32 paymentId, uint256 amount, bytes32 currency)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            UnifiedPaymentVerifierV4.PaymentDetails(method, PAYEE, amount, currency, TIMESTAMP * 1000, paymentId),
            UnifiedPaymentVerifierV4.IntentSnapshot(intentHash, amount, method, currency, PAYEE, 1e18, TIMESTAMP, 60)
        );
    }

    function _proof(
        bytes32 intentHash,
        bytes32 method,
        bytes32 paymentId,
        bytes32 domain,
        uint256 amount,
        bytes32 currency
    ) internal view returns (bytes memory) {
        bytes memory data = _payload(intentHash, method, paymentId, amount, currency);
        bytes32 dataHash = keccak256(data);
        bytes32 typeHash = keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)");
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, intentHash, amount, dataHash)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return
            abi.encode(UnifiedPaymentVerifierV4.PaymentAttestation(intentHash, amount, dataHash, signatures, data, ""));
    }

    function _firstVerify(UnifiedPaymentVerifierV4 target, bytes32 method, bytes32 paymentId) internal {
        bytes memory proof = _proof(FIRST_INTENT, method, paymentId, target.DOMAIN_SEPARATOR(), AMOUNT, USD);
        IPaymentVerifier.PaymentVerificationResult memory result =
            firstCaller.verifyPayment(target, _verifyData(FIRST_INTENT, proof));
        assertTrue(result.success);
        assertEq(result.intentHash, FIRST_INTENT);
        assertEq(result.releaseAmount, AMOUNT);
    }

    function _verifyData(bytes32 intentHash, bytes memory proof)
        internal
        pure
        returns (IPaymentVerifier.VerifyPaymentData memory)
    {
        return IPaymentVerifier.VerifyPaymentData(intentHash, proof, "");
    }

    function _venmoNullifier(bytes32 paymentId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(VENMO, paymentId));
    }
}
