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
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {INullifierRegistryV3} from "contracts/interfaces/INullifierRegistryV3.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
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
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);
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

    bytes32 internal constant PAYMENT_ID = keccak256("payment-id");
    bytes32 internal constant BUYER_NULLIFIER = keccak256("buyer-nullifier");
    bytes32 internal constant SELLER_NULLIFIER = keccak256("seller-nullifier");
    bytes32 internal constant SHARED_NULLIFIER = keccak256("shared-nullifier");

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
        verifier = new UnifiedPaymentVerifierV5(
            orchestratorRegistry, INullifierRegistryV2(address(nullifierRegistry)), attestationVerifier
        );
        caller = new UnifiedPaymentVerifierV4V4CallerHarness();

        orchestratorRegistry.addOrchestrator(address(caller));
        nullifierRegistry.addWritePermission(address(verifier));
        legacyRegistry.addWritePermission(address(this));
        predecessor.addWritePermission(address(this));
        verifier.addPaymentMethod(METHOD);
        caller.setIntent(INTENT_A, _intent());
        caller.setIntent(INTENT_B, _intent());
    }

    /* ============ Signed nullifiers ============ */

    /// @dev The verifier neither hashes nor derives: the registry holds exactly the signed words.
    function test_StoresTheSignedNullifierAsGivenAndReturnsTheReceipt() public {
        vm.expectEmit(true, true, true, true, address(nullifierRegistry));
        emit NullifierAdded(BUYER_NULLIFIER, INTENT_A, address(verifier));
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(INTENT_A, METHOD, USD, AMOUNT, TIMESTAMP * 1000, PAYMENT_ID, PAYEE);
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result, bytes memory settlementData) =
            _verify(INTENT_A, _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER), hex"deadbeef"));

        assertTrue(result.success);
        assertEq(result.intentHash, INTENT_A);
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(result.attestedReleaseAmount, AMOUNT);
        assertEq(result.payment.method, METHOD);
        assertEq(result.payment.payeeId, PAYEE);
        assertEq(result.payment.amount, AMOUNT);
        assertEq(result.payment.currency, USD);
        assertEq(result.payment.timestamp, TIMESTAMP * 1000);
        assertEq(result.payment.paymentId, PAYMENT_ID);
        assertEq(settlementData, hex"deadbeef");
        assertEq(nullifierRegistry.intentHashByNullifier(BUYER_NULLIFIER), INTENT_A);
        assertFalse(nullifierRegistry.isNullified(keccak256(abi.encodePacked(METHOD, PAYMENT_ID))));
        assertFalse(nullifierRegistry.isNullified(keccak256(abi.encodePacked(METHOD, BUYER_NULLIFIER))));
    }

    function test_ConsumesEveryNullifierForOneIntent() public {
        vm.expectEmit(true, true, true, true, address(nullifierRegistry));
        emit NullifierAdded(BUYER_NULLIFIER, INTENT_A, address(verifier));
        vm.expectEmit(true, true, true, true, address(nullifierRegistry));
        emit NullifierAdded(SHARED_NULLIFIER, INTENT_A, address(verifier));
        vm.expectEmit(true, true, true, true, address(verifier));
        emit PaymentVerified(INTENT_A, METHOD, USD, AMOUNT, TIMESTAMP * 1000, PAYMENT_ID, PAYEE);
        _verify(INTENT_A, _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER), ""));

        assertEq(nullifierRegistry.intentHashByNullifier(BUYER_NULLIFIER), INTENT_A);
        assertEq(nullifierRegistry.intentHashByNullifier(SHARED_NULLIFIER), INTENT_A);
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
                INTENT_A, _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER), ""), ""
            )
        );

        assertTrue(result.success);
        assertEq(nullifierRegistry.intentHashByNullifier(SHARED_NULLIFIER), INTENT_A);
    }

    /* ============ Two proofs of one transfer ============ */

    /// @dev Buyer and seller proofs carry their own nullifier plus a shared one. The shared one stops the second.
    function test_BuyerProofFirstBlocksTheSellerProofOfTheSameTransfer() public {
        _verify(INTENT_A, _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER), ""));

        bytes memory sellerProof = _proof(INTENT_B, _nullifiers(SELLER_NULLIFIER, SHARED_NULLIFIER), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_B, sellerProof);

        assertFalse(nullifierRegistry.isNullified(SELLER_NULLIFIER));
        assertEq(nullifierRegistry.intentHashByNullifier(SHARED_NULLIFIER), INTENT_A);
    }

    function test_SellerProofFirstBlocksTheBuyerProofOfTheSameTransfer() public {
        _verify(INTENT_B, _proof(INTENT_B, _nullifiers(SELLER_NULLIFIER, SHARED_NULLIFIER), ""));

        bytes memory buyerProof = _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, buyerProof);

        assertFalse(nullifierRegistry.isNullified(BUYER_NULLIFIER));
        assertEq(nullifierRegistry.intentHashByNullifier(SHARED_NULLIFIER), INTENT_B);
    }

    /// @dev Without a common nullifier the registry cannot tell the two proofs describe one transfer. The
    /// attestation service owns giving every proof route of a transfer a common nullifier.
    function test_ProofsWithNoCommonNullifierBothSettle() public {
        _verify(INTENT_A, _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER), ""));
        _verify(INTENT_B, _proof(INTENT_B, _nullifiers(SELLER_NULLIFIER), ""));

        assertEq(nullifierRegistry.intentHashByNullifier(BUYER_NULLIFIER), INTENT_A);
        assertEq(nullifierRegistry.intentHashByNullifier(SELLER_NULLIFIER), INTENT_B);
    }

    /* ============ Replay across registries ============ */

    /// @dev A pre-cutover payment stays spent only when the attestation signs the nullifier the predecessor holds.
    function test_PaymentSettledBeforeCutoverCannotSettleAgain() public {
        bytes32 predecessorNullifier = keccak256(abi.encodePacked(METHOD, PAYMENT_ID));
        predecessor.addNullifier(predecessorNullifier, keccak256("pre-cutover-intent"));
        bytes memory proof = _proof(INTENT_A, _nullifiers(predecessorNullifier, SHARED_NULLIFIER), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);
        assertFalse(nullifierRegistry.isNullified(SHARED_NULLIFIER));

        bytes32 legacyNullifier = keccak256("legacy-nullifier");
        legacyRegistry.addNullifier(legacyNullifier);
        proof = _proof(INTENT_A, _nullifiers(legacyNullifier), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);
    }

    /* ============ Rejected nullifier lists ============ */

    function test_RejectsEmptyZeroAndRepeatedNullifiers() public {
        bytes memory proof = _proof(INTENT_A, new bytes32[](0), "");
        vm.expectRevert("UPV: No nullifiers");
        _verify(INTENT_A, proof);

        proof = _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, bytes32(0)), "");
        vm.expectRevert(INullifierRegistryV3.ZeroNullifier.selector);
        _verify(INTENT_A, proof);

        proof = _proof(INTENT_A, _nullifiers(SHARED_NULLIFIER, SHARED_NULLIFIER), "");
        vm.expectRevert("Nullifier has already been used");
        _verify(INTENT_A, proof);

        assertFalse(nullifierRegistry.isNullified(BUYER_NULLIFIER));
        assertFalse(nullifierRegistry.isNullified(SHARED_NULLIFIER));
    }

    function test_SignedNullifierListCannotBeExtendedOrTrimmed() public {
        UnifiedPaymentVerifierV5.PaymentAttestation memory attestation = abi.decode(
            _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER), ""),
            (UnifiedPaymentVerifierV5.PaymentAttestation)
        );
        attestation.data = abi.encode(_payment(), _snapshot(INTENT_A), bytes(""), _nullifiers(BUYER_NULLIFIER));
        vm.expectRevert("UPV: Data hash mismatch");
        _verify(INTENT_A, abi.encode(attestation));

        attestation.dataHash = keccak256(attestation.data);
        vm.expectRevert();
        _verify(INTENT_A, abi.encode(attestation));

        assertFalse(nullifierRegistry.isNullified(BUYER_NULLIFIER));
    }

    /// @dev The fixed-size payment and snapshot fields stay where V4 put them; the list is appended.
    function test_PayloadKeepsTheV4PrefixAndAppendsTheList() public {
        bytes memory v4 = abi.encode(_payment(), _snapshot(INTENT_A), bytes(""));
        bytes memory v5 = abi.encode(_payment(), _snapshot(INTENT_A), bytes(""), _nullifiers(BUYER_NULLIFIER));

        // Six payment words and ten snapshot words.
        for (uint256 offset = 32; offset <= 16 * 32; offset += 32) {
            bytes32 expected;
            bytes32 actual;
            assembly {
                expected := mload(add(v4, offset))
                actual := mload(add(v5, offset))
            }
            assertEq(actual, expected);
        }
    }

    /* ============ Checks preserved from V4 ============ */

    function test_RejectsMalformedPaymentsWithoutConsumingANullifier() public {
        IPaymentVerifierV2.PaymentDetails memory payment = _payment();
        IPaymentVerifierV2.IntentSnapshot memory snapshot = _snapshot(INTENT_A);

        _expectFailure(_proof(INTENT_B, AMOUNT, payment, snapshot), "UPV: Attestation hash mismatch");
        _expectFailure(_proof(INTENT_A, 0, payment, snapshot), "UPV: Invalid release amount");

        payment.method = keccak256("unknown");
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Invalid payment method");
        verifier.addPaymentMethod(payment.method);
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Payment method mismatch");
        payment = _payment();

        payment.paymentId = bytes32(0);
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Invalid payment ID");
        payment = _payment();

        payment.amount = 0;
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Invalid payment amount");
        payment = _payment();

        payment.currency = bytes32(0);
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Invalid payment currency");
        payment = _payment();

        snapshot.intentHash = INTENT_B;
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Snapshot hash mismatch");
        snapshot = _snapshot(INTENT_A);

        snapshot.amount = AMOUNT + 1;
        _expectFailure(_proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Snapshot amount mismatch");
        snapshot = _snapshot(INTENT_A);

        snapshot.timestampBuffer = 48 hours * 1000 + 1;
        _expectFailure(
            _proof(INTENT_A, AMOUNT, payment, snapshot), "UPV: Snapshot timestamp buffer exceeds maximum"
        );
        snapshot = _snapshot(INTENT_A);

        bytes memory unauthorized = _sign(
            INTENT_A, AMOUNT, abi.encode(payment, snapshot, bytes(""), _nullifiers(BUYER_NULLIFIER)), 0xBAD
        );
        vm.expectRevert();
        _verify(INTENT_A, unauthorized);

        assertFalse(nullifierRegistry.isNullified(BUYER_NULLIFIER));
        assertFalse(nullifierRegistry.isNullified(SHARED_NULLIFIER));
    }

    function test_CapsTheReleaseAtTheIntentAmountAndKeepsTheAttestedAmount() public {
        bytes memory data = abi.encode(_payment(), _snapshot(INTENT_A), bytes(""), _nullifiers(BUYER_NULLIFIER));
        (IPaymentVerifierV2.PaymentVerificationResultV2 memory result,) =
            _verify(INTENT_A, _sign(INTENT_A, AMOUNT + 1, data, WITNESS_KEY));
        assertEq(result.releaseAmount, AMOUNT);
        assertEq(result.attestedReleaseAmount, AMOUNT + 1);

        data = abi.encode(_payment(), _snapshot(INTENT_B), bytes(""), _nullifiers(SELLER_NULLIFIER));
        (result,) = _verify(INTENT_B, _sign(INTENT_B, AMOUNT - 1, data, WITNESS_KEY));
        assertEq(result.releaseAmount, AMOUNT - 1);
        assertEq(result.attestedReleaseAmount, AMOUNT - 1);
    }

    function test_OnlyRegisteredSupportedOrchestratorsCanVerify() public {
        bytes memory proof = _proof(INTENT_A, _nullifiers(BUYER_NULLIFIER), "");
        IPaymentVerifierV2.VerifyPaymentData memory request =
            IPaymentVerifierV2.VerifyPaymentData(INTENT_A, proof, "");

        vm.expectRevert("Only orchestrator can call");
        verifier.verifyPayment(request);

        UnshapedCaller unshaped = new UnshapedCaller();
        orchestratorRegistry.addOrchestrator(address(unshaped));
        vm.expectRevert("UPV: Unsupported orchestrator");
        unshaped.verifyPayment(IPaymentVerifierV2(address(verifier)), request);

        assertFalse(nullifierRegistry.isNullified(BUYER_NULLIFIER));
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
        INullifierRegistryV2 registry = INullifierRegistryV2(address(nullifierRegistry));
        vm.expectRevert("UPV: Invalid orchestrator registry");
        new UnifiedPaymentVerifierV5(OrchestratorRegistry(empty), registry, attestationVerifier);
        vm.expectRevert("UPV: Invalid nullifier registry");
        new UnifiedPaymentVerifierV5(orchestratorRegistry, INullifierRegistryV2(empty), attestationVerifier);
        vm.expectRevert("UPV: Invalid attestation verifier");
        new UnifiedPaymentVerifierV5(orchestratorRegistry, registry, SimpleAttestationVerifier(empty));

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

    function _nullifiers(bytes32 first) internal pure returns (bytes32[] memory nullifiers) {
        nullifiers = new bytes32[](1);
        nullifiers[0] = first;
    }

    function _nullifiers(bytes32 first, bytes32 second) internal pure returns (bytes32[] memory nullifiers) {
        nullifiers = new bytes32[](2);
        nullifiers[0] = first;
        nullifiers[1] = second;
    }

    function _payment() internal pure returns (IPaymentVerifierV2.PaymentDetails memory) {
        return IPaymentVerifierV2.PaymentDetails({
            method: METHOD,
            payeeId: PAYEE,
            amount: AMOUNT,
            currency: USD,
            timestamp: TIMESTAMP * 1000,
            paymentId: PAYMENT_ID
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

    function _proof(bytes32 intentHash, bytes32[] memory nullifiers, bytes memory settlementData)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            intentHash, AMOUNT, abi.encode(_payment(), _snapshot(intentHash), settlementData, nullifiers), WITNESS_KEY
        );
    }

    function _proof(
        bytes32 attestedIntentHash,
        uint256 releaseAmount,
        IPaymentVerifierV2.PaymentDetails memory payment,
        IPaymentVerifierV2.IntentSnapshot memory snapshot
    ) internal view returns (bytes memory) {
        return _sign(
            attestedIntentHash,
            releaseAmount,
            abi.encode(payment, snapshot, bytes(""), _nullifiers(BUYER_NULLIFIER, SHARED_NULLIFIER)),
            WITNESS_KEY
        );
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
