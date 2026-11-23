// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {UnifiedPaymentVerifierV5} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV5.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {PaymentNullifierLib} from "contracts/lib/PaymentNullifierLib.sol";
import {
    UnifiedPaymentVerifierV4CallerHarness,
    UnifiedPaymentVerifierV4V4CallerHarness
} from "../../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

/// @dev Registered orchestrator that answers neither the V4 ERC-165 probe nor the V2 hook probe.
contract UnshapedCaller {
    function verifyPayment(IPaymentVerifierV2 verifier, IPaymentVerifierV2.VerifyPaymentData calldata data)
        external
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory, bytes memory)
    {
        return verifier.verifyPayment(data);
    }
}

contract UnifiedPaymentVerifierV5Test is Test {
    event PaymentVerified(
        bytes32 indexed intentHash,
        bytes32 indexed method,
        bytes32 indexed currency,
        uint256 amount,
        uint256 timestamp,
        bytes32 paymentId,
        bytes32 payeeId
    );
    event PaymentIdConsumed(bytes32 indexed intentHash, bytes32 indexed scheme, bytes32 id);
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);
    event RequiredSchemesUpdated(bytes32 indexed paymentMethod, bytes32[] schemes);
    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event AttestationVerifierUpdated(address indexed oldVerifier, address indexed newVerifier);

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant AMOUNT = 50e6;
    uint256 internal constant TIMESTAMP = 1_000_000;
    uint256 internal constant CONVERSION_RATE = 1e18;
    bytes32 internal constant METHOD = keccak256("method");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant INTENT_A = keccak256("intent-a");
    bytes32 internal constant INTENT_B = keccak256("intent-b");

    bytes32 internal constant NATIVE = bytes32(0);
    bytes32 internal constant SHARED_SCHEME = keccak256("shared-transfer.v1");
    bytes32 internal constant SELLER_SCHEME = keccak256("seller-record.v1");
    bytes32 internal constant NATIVE_ID = keccak256("native-transaction");
    bytes32 internal constant SHARED_ID = keccak256("shared-transfer");
    bytes32 internal constant SELLER_ID = keccak256("seller-row");

    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal predecessor;
    NullifierRegistryV3 internal nullifierRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    SimpleAttestationVerifier internal attestationVerifier;
    UnifiedPaymentVerifierV5 internal verifier;
    UnifiedPaymentVerifierV4V4CallerHarness internal caller;

    function setUp() public {
        vm.warp(TIMESTAMP);
        legacyRegistry = new NullifierRegistry();
        predecessor = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
        nullifierRegistry = new NullifierRegistryV3(predecessor);
        orchestratorRegistry = new OrchestratorRegistry();
        attestationVerifier = new SimpleAttestationVerifier(vm.addr(WITNESS_KEY));
        verifier = new UnifiedPaymentVerifierV5(orchestratorRegistry, nullifierRegistry, attestationVerifier);
        caller = new UnifiedPaymentVerifierV4V4CallerHarness();

        orchestratorRegistry.addOrchestrator(address(caller));
        nullifierRegistry.addWritePermission(address(verifier));
        legacyRegistry.addWritePermission(address(this));
        predecessor.addWritePermission(address(this));
        verifier.addPaymentMethod(METHOD);
        caller.setIntent(INTENT_A, _intent());
        caller.setIntent(INTENT_B, _intent());
    }

    /* ============ One ID ============ */

    function test_NativeIdKeepsThePredecessorKeyAndTheReceipt() public {
        bytes32 key = keccak256(abi.encodePacked(METHOD, NATIVE_ID));
        assertEq(PaymentNullifierLib.key(METHOD, NATIVE, NATIVE_ID), key);

        vm.expectEmit(true, true, true, true, address(nullifierRegistry));
        emit NullifierAdded(key, INTENT_A, address(verifier));
        vm.expectEmit(true, true, false, true, address(verifier));
        emit PaymentIdConsumed(INTENT_A, NATIVE, NATIVE_ID);
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(INTENT_A, METHOD, USD, AMOUNT, TIMESTAMP * 1000, NATIVE_ID, PAYEE);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory settlementData) =
            _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID), hex"deadbeef"));

        assertTrue(result.success);
        assertEq(result.intentHash, INTENT_A);
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(result.attestedReleaseAmount, AMOUNT);
        assertEq(result.payment.method, METHOD);
        assertEq(result.payment.payeeId, PAYEE);
        assertEq(result.payment.amount, AMOUNT);
        assertEq(result.payment.currency, USD);
        assertEq(result.payment.timestamp, TIMESTAMP * 1000);
        assertEq(result.payment.paymentId, NATIVE_ID);
        assertEq(settlementData, hex"deadbeef");
        assertEq(nullifierRegistry.intentHashByNullifier(key), INTENT_A);
    }

    function test_ServesV2ShapedOrchestrators() public {
        UnifiedPaymentVerifierV4CallerHarness v2Caller = new UnifiedPaymentVerifierV4CallerHarness();
        v2Caller.setIntent(
            INTENT_A,
            IOrchestratorV2.Intent({
                owner: address(this),
                to: address(this),
                escrow: address(1),
                depositId: 0,
                amount: AMOUNT,
                timestamp: TIMESTAMP,
                paymentMethod: METHOD,
                fiatCurrency: USD,
                conversionRate: CONVERSION_RATE,
                payeeId: PAYEE,
                referralFees: new IReferralFee.ReferralFee[](0),
                postIntentHook: IPostIntentHookV2(address(0)),
                data: ""
            })
        );
        orchestratorRegistry.addOrchestrator(address(v2Caller));

        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result,) = v2Caller.verifyPayment(
            IPaymentVerifierV2(address(verifier)),
            IPaymentVerifierV2.VerifyPaymentData(
                INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), ""), ""
            )
        );

        assertTrue(result.success);
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SHARED_SCHEME, SHARED_ID)), INTENT_A);
    }

    /* ============ Several IDs ============ */

    function test_ConsumesEveryIdForOneIntentAndReturnsThePrimary() public {
        vm.expectEmit(true, true, false, true, address(verifier));
        emit PaymentIdConsumed(INTENT_A, NATIVE, NATIVE_ID);
        vm.expectEmit(true, true, false, true, address(verifier));
        emit PaymentIdConsumed(INTENT_A, SHARED_SCHEME, SHARED_ID);
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(INTENT_A, METHOD, USD, AMOUNT, TIMESTAMP * 1000, NATIVE_ID, PAYEE);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result,) =
            _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), ""));

        assertEq(result.payment.paymentId, NATIVE_ID);
        assertEq(_key(SHARED_SCHEME, SHARED_ID), keccak256(abi.encode(METHOD, SHARED_SCHEME, SHARED_ID)));
        assertEq(nullifierRegistry.intentHashByNullifier(_key(NATIVE, NATIVE_ID)), INTENT_A);
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SHARED_SCHEME, SHARED_ID)), INTENT_A);
    }

    /// @dev Buyer and seller name one transfer by different primaries. The shared ID is what stops the second.
    function test_BuyerProofFirstBlocksTheSellerProofOfTheSameTransfer() public {
        _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), ""));

        bytes memory sellerProof = _proof(INTENT_B, _ids(SELLER_SCHEME, SELLER_ID, SHARED_SCHEME, SHARED_ID), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_B, sellerProof);

        assertFalse(nullifierRegistry.isNullified(_key(SELLER_SCHEME, SELLER_ID)));
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SHARED_SCHEME, SHARED_ID)), INTENT_A);
    }

    function test_SellerProofFirstBlocksTheBuyerProofOfTheSameTransfer() public {
        _verify(INTENT_B, _proof(INTENT_B, _ids(SELLER_SCHEME, SELLER_ID, SHARED_SCHEME, SHARED_ID), ""));

        bytes memory buyerProof = _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, buyerProof);

        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SHARED_SCHEME, SHARED_ID)), INTENT_B);
    }

    /// @dev Without a common ID the registry cannot tell the two proofs describe one transfer.
    function test_ProofsWithNoCommonIdBothSettle() public {
        _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID), ""));
        _verify(INTENT_B, _proof(INTENT_B, _ids(SELLER_SCHEME, SELLER_ID), ""));

        assertEq(nullifierRegistry.intentHashByNullifier(_key(NATIVE, NATIVE_ID)), INTENT_A);
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SELLER_SCHEME, SELLER_ID)), INTENT_B);
    }

    function test_OneIdUnderTwoSchemesIsTwoKeys() public {
        _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID), ""));
        _verify(INTENT_B, _proof(INTENT_B, _ids(SHARED_SCHEME, NATIVE_ID), ""));

        assertTrue(_key(NATIVE, NATIVE_ID) != _key(SHARED_SCHEME, NATIVE_ID));
        assertEq(nullifierRegistry.intentHashByNullifier(_key(NATIVE, NATIVE_ID)), INTENT_A);
        assertEq(nullifierRegistry.intentHashByNullifier(_key(SHARED_SCHEME, NATIVE_ID)), INTENT_B);
    }

    /* ============ Replay across registries ============ */

    function test_PaymentSettledBeforeCutoverCannotSettleAgain() public {
        predecessor.addNullifier(_key(NATIVE, NATIVE_ID), keccak256("pre-cutover-intent"));
        bytes memory proof = _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);
        assertFalse(nullifierRegistry.isNullified(_key(SHARED_SCHEME, SHARED_ID)));

        bytes32 legacyId = keccak256("legacy-transaction");
        legacyRegistry.addNullifier(_key(NATIVE, legacyId));
        proof = _proof(INTENT_A, _ids(NATIVE, legacyId), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);
    }

    /* ============ Rejected ID lists ============ */

    function test_RejectsEmptyZeroAndRepeatedIds() public {
        bytes memory proof = _proof(INTENT_A, new UnifiedPaymentVerifierV5.PaymentId[](0), "");
        vm.expectRevert("UPV: Invalid payment ID");
        _verify(INTENT_A, proof);

        proof = _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, bytes32(0)), "");
        vm.expectRevert("UPV: Invalid payment ID");
        _verify(INTENT_A, proof);

        proof = _proof(INTENT_A, _ids(SHARED_SCHEME, SHARED_ID, SHARED_SCHEME, SHARED_ID), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);

        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));
        assertFalse(nullifierRegistry.isNullified(_key(SHARED_SCHEME, SHARED_ID)));
    }

    function test_SignedIdListCannotBeExtendedOrTrimmed() public {
        UnifiedPaymentVerifierV5.PaymentAttestation memory attestation = abi.decode(
            _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), ""),
            (UnifiedPaymentVerifierV5.PaymentAttestation)
        );
        attestation.data = abi.encode(_details(_ids(NATIVE, NATIVE_ID)), _snapshot(INTENT_A), bytes(""));
        vm.expectRevert("UPV: Data hash mismatch");
        _verify(INTENT_A, abi.encode(attestation));

        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert();
        _verify(INTENT_A, abi.encode(attestation));

        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));
    }

    /* ============ Required schemes ============ */

    function test_ProofMissingARequiredSchemeIsRejected() public {
        bytes32[] memory schemes = new bytes32[](1);
        schemes[0] = SHARED_SCHEME;
        vm.expectEmit(true, false, false, true, address(verifier));
        emit RequiredSchemesUpdated(METHOD, schemes);
        verifier.setRequiredSchemes(METHOD, schemes);
        assertEq(verifier.getRequiredSchemes(METHOD), schemes);

        bytes memory proof = _proof(INTENT_A, _ids(NATIVE, NATIVE_ID), "");
        vm.expectRevert("UPV: Missing required payment ID scheme");
        _verify(INTENT_A, proof);
        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));

        _verify(INTENT_A, _proof(INTENT_A, _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID), ""));
        proof = _proof(INTENT_B, _ids(SELLER_SCHEME, SELLER_ID, SHARED_SCHEME, SHARED_ID), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_B, proof);
    }

    function test_RequiredSchemesAreOwnerGovernedAndClearedWithTheMethod() public {
        bytes32[] memory schemes = new bytes32[](2);
        schemes[0] = SHARED_SCHEME;
        schemes[1] = NATIVE;

        vm.prank(makeAddr("attacker"));
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setRequiredSchemes(METHOD, schemes);
        vm.expectRevert("UPV: Payment method does not exist");
        verifier.setRequiredSchemes(keccak256("unknown"), schemes);

        verifier.setRequiredSchemes(METHOD, schemes);
        assertEq(verifier.getRequiredSchemes(METHOD), schemes);

        verifier.removePaymentMethod(METHOD);
        verifier.addPaymentMethod(METHOD);
        assertEq(verifier.getRequiredSchemes(METHOD).length, 0);
        _verify(INTENT_A, _proof(INTENT_A, _ids(SELLER_SCHEME, SELLER_ID), ""));
    }

    /* ============ Checks preserved from V4 ============ */

    function test_RejectsMalformedPaymentsWithoutConsumingAnId() public {
        UnifiedPaymentVerifierV5.PaymentId[] memory ids = _ids(NATIVE, NATIVE_ID, SHARED_SCHEME, SHARED_ID);
        UnifiedPaymentVerifierV5.SignedPaymentDetails memory details = _details(ids);
        IPaymentVerifierV2.IntentSnapshot memory snapshot = _snapshot(INTENT_A);

        _expectFailure(_proof(INTENT_B, AMOUNT, details, snapshot), "UPV: Attestation hash mismatch");
        _expectFailure(_proof(INTENT_A, 0, details, snapshot), "UPV: Invalid release amount");

        details.method = keccak256("unknown");
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Invalid payment method");
        verifier.addPaymentMethod(details.method);
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Payment method mismatch");
        details = _details(ids);

        details.amount = 0;
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Invalid payment amount");
        details = _details(ids);

        details.currency = bytes32(0);
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Invalid payment currency");
        details = _details(ids);

        snapshot.intentHash = INTENT_B;
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Snapshot hash mismatch");
        snapshot = _snapshot(INTENT_A);

        snapshot.amount = AMOUNT + 1;
        _expectFailure(_proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Snapshot amount mismatch");
        snapshot = _snapshot(INTENT_A);

        snapshot.timestampBuffer = 48 hours * 1000 + 1;
        _expectFailure(
            _proof(INTENT_A, AMOUNT, details, snapshot), "UPV: Snapshot timestamp buffer exceeds maximum"
        );
        snapshot = _snapshot(INTENT_A);

        bytes memory unauthorized = _sign(INTENT_A, AMOUNT, abi.encode(details, snapshot, bytes("")), 0xBAD);
        vm.expectRevert();
        _verify(INTENT_A, unauthorized);

        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));
        assertFalse(nullifierRegistry.isNullified(_key(SHARED_SCHEME, SHARED_ID)));
    }

    function test_CapsTheReleaseAtTheIntentAmountAndKeepsTheAttestedAmount() public {
        UnifiedPaymentVerifierV5.SignedPaymentDetails memory details = _details(_ids(NATIVE, NATIVE_ID));
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result,) =
            _verify(INTENT_A, _proof(INTENT_A, AMOUNT + 1, details, _snapshot(INTENT_A)));
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(result.attestedReleaseAmount, AMOUNT + 1);

        details = _details(_ids(SHARED_SCHEME, SHARED_ID));
        (result,) = _verify(INTENT_B, _proof(INTENT_B, AMOUNT - 1, details, _snapshot(INTENT_B)));
        assertEq(result.releaseAmount, AMOUNT - 1);
        assertEq(result.attestedReleaseAmount, AMOUNT - 1);
    }

    function test_OnlyRegisteredSupportedOrchestratorsCanVerify() public {
        bytes memory proof = _proof(INTENT_A, _ids(NATIVE, NATIVE_ID), "");
        IPaymentVerifierV2.VerifyPaymentData memory request =
            IPaymentVerifierV2.VerifyPaymentData(INTENT_A, proof, "");

        vm.expectRevert("Only orchestrator can call");
        verifier.verifyPayment(request);

        UnshapedCaller unshaped = new UnshapedCaller();
        orchestratorRegistry.addOrchestrator(address(unshaped));
        vm.expectRevert("UPV: Unsupported orchestrator");
        unshaped.verifyPayment(IPaymentVerifierV2(address(verifier)), request);

        assertFalse(nullifierRegistry.isNullified(_key(NATIVE, NATIVE_ID)));
    }

    function test_PaymentMethodsAndAttestationVerifierAreOwnerGoverned() public {
        bytes32 other = keccak256("other");
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.addPaymentMethod(other);
        vm.expectRevert("UPV: Payment method already exists");
        verifier.addPaymentMethod(METHOD);
        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodAdded(other);
        verifier.addPaymentMethod(other);
        bytes32[] memory methods = verifier.getPaymentMethods();
        assertEq(methods.length, 2);
        assertEq(methods[0], METHOD);
        assertEq(methods[1], other);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.removePaymentMethod(other);
        vm.expectEmit(true, false, false, true, address(verifier));
        emit PaymentMethodRemoved(other);
        verifier.removePaymentMethod(other);
        vm.expectRevert("UPV: Payment method does not exist");
        verifier.removePaymentMethod(other);
        assertFalse(verifier.isPaymentMethod(other));

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        verifier.setAttestationVerifier(address(attestationVerifier));
        vm.expectRevert("UPV: Invalid attestation verifier");
        verifier.setAttestationVerifier(attacker);
        vm.expectRevert("UPV: Same verifier");
        verifier.setAttestationVerifier(address(attestationVerifier));
        SimpleAttestationVerifier replacement = new SimpleAttestationVerifier(vm.addr(WITNESS_KEY));
        vm.expectEmit(true, true, false, true, address(verifier));
        emit AttestationVerifierUpdated(address(attestationVerifier), address(replacement));
        verifier.setAttestationVerifier(address(replacement));
        assertEq(address(verifier.attestationVerifier()), address(replacement));
    }

    function test_ConstructorRequiresDeployedDependenciesAndBindsTheDomain() public {
        address empty = makeAddr("empty");
        vm.expectRevert("UPV: Invalid orchestrator registry");
        new UnifiedPaymentVerifierV5(OrchestratorRegistry(empty), nullifierRegistry, attestationVerifier);
        vm.expectRevert("UPV: Invalid nullifier registry");
        new UnifiedPaymentVerifierV5(orchestratorRegistry, NullifierRegistryV3(empty), attestationVerifier);
        vm.expectRevert("UPV: Invalid attestation verifier");
        new UnifiedPaymentVerifierV5(orchestratorRegistry, nullifierRegistry, SimpleAttestationVerifier(empty));

        assertEq(address(verifier.nullifierRegistry()), address(nullifierRegistry));
        assertEq(
            verifier.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256(bytes("UnifiedPaymentVerifier")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(verifier)
                )
            )
        );
    }

    /* ============ Helpers ============ */

    function _intent() internal view returns (IOrchestratorV4.Intent memory) {
        return IOrchestratorV4.Intent({
            owner: address(this),
            to: address(this),
            escrow: address(1),
            depositId: 0,
            amount: AMOUNT,
            timestamp: TIMESTAMP,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            payeeId: PAYEE,
            referralFees: new IReferralFee.ReferralFee[](0),
            payerCommitment: "",
            takerWhitelisted: false,
            arbitrator: address(0)
        });
    }

    function _ids(bytes32 scheme, bytes32 id) internal pure returns (UnifiedPaymentVerifierV5.PaymentId[] memory ids) {
        ids = new UnifiedPaymentVerifierV5.PaymentId[](1);
        ids[0] = UnifiedPaymentVerifierV5.PaymentId(scheme, id);
    }

    function _ids(bytes32 firstScheme, bytes32 firstId, bytes32 secondScheme, bytes32 secondId)
        internal
        pure
        returns (UnifiedPaymentVerifierV5.PaymentId[] memory ids)
    {
        ids = new UnifiedPaymentVerifierV5.PaymentId[](2);
        ids[0] = UnifiedPaymentVerifierV5.PaymentId(firstScheme, firstId);
        ids[1] = UnifiedPaymentVerifierV5.PaymentId(secondScheme, secondId);
    }

    function _key(bytes32 scheme, bytes32 id) internal pure returns (bytes32) {
        return PaymentNullifierLib.key(METHOD, scheme, id);
    }

    function _details(UnifiedPaymentVerifierV5.PaymentId[] memory ids)
        internal
        pure
        returns (UnifiedPaymentVerifierV5.SignedPaymentDetails memory)
    {
        return UnifiedPaymentVerifierV5.SignedPaymentDetails({
            method: METHOD,
            payeeId: PAYEE,
            amount: AMOUNT,
            currency: USD,
            timestamp: TIMESTAMP * 1000,
            paymentIds: ids
        });
    }

    function _snapshot(bytes32 intentHash) internal view returns (IPaymentVerifierV2.IntentSnapshot memory) {
        return IPaymentVerifierV2.IntentSnapshot({
            intentHash: intentHash,
            amount: AMOUNT,
            paymentMethod: METHOD,
            fiatCurrency: USD,
            payeeDetails: PAYEE,
            conversionRate: CONVERSION_RATE,
            signalTimestamp: TIMESTAMP,
            timestampBuffer: 0,
            payerCommitmentHash: bytes32(0),
            owner: address(this)
        });
    }

    function _proof(bytes32 intentHash, UnifiedPaymentVerifierV5.PaymentId[] memory ids, bytes memory settlementData)
        internal
        view
        returns (bytes memory)
    {
        return _sign(intentHash, AMOUNT, abi.encode(_details(ids), _snapshot(intentHash), settlementData), WITNESS_KEY);
    }

    function _proof(
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        UnifiedPaymentVerifierV5.SignedPaymentDetails memory details,
        IPaymentVerifierV2.IntentSnapshot memory snapshot
    ) internal view returns (bytes memory) {
        return _sign(attestedIntentHash, releaseAmount, abi.encode(details, snapshot, bytes("")), WITNESS_KEY);
    }

    function _sign(bytes32 intentHash, uint256 releaseAmount, bytes memory data, uint256 signerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 dataHash = keccak256(data);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                intentHash,
                releaseAmount,
                dataHash
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerKey, keccak256(abi.encodePacked("\x19\x01", verifier.DOMAIN_SEPARATOR(), structHash)));
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifierV5.PaymentAttestation({
                intentHash: intentHash,
                releaseAmount: releaseAmount,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }

    function _expectFailure(bytes memory proof, string memory reason) internal {
        vm.expectRevert(bytes(reason));
        _verify(INTENT_A, proof);
    }

    function _verify(bytes32 intentHash, bytes memory proof)
        internal
        returns (IPaymentVerifierV2.PaymentVerificationResultV2 memory, bytes memory)
    {
        return caller.verifyPayment(
            IPaymentVerifierV2(address(verifier)), IPaymentVerifierV2.VerifyPaymentData(intentHash, proof, "")
        );
    }
}
