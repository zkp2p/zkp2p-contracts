// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {INullifierRegistryV3} from "contracts/interfaces/INullifierRegistryV3.sol";
import {IOrchestratorV4} from "contracts/interfaces/IOrchestratorV4.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV5} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV5.sol";
import {UnifiedPaymentVerifierV4V4CallerHarness} from "../mocks/UnifiedPaymentVerifierV4CallerHarness.sol";

/**
 * @notice Opt-in rehearsal of NullifierRegistryV3 over the live Base NullifierRegistryV2, outside coverage's
 * deterministic tree. Skips unless `BASE_FORK_RPC_URL` is set.
 * @dev Forks the latest block, so a non-archive RPC works: the pinned settlement is permanent V2 history.
 */
contract NullifierRegistryV3BaseForkTest is Test {
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);

    address internal constant NULLIFIER_REGISTRY_V1 = 0x8d8e1A0e5345a5cc9AA206c3ca76D6d28c514608;
    address internal constant NULLIFIER_REGISTRY_V2 = 0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB;
    address internal constant MULTI_ATTESTATION_VERIFIER = 0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5;

    /// @dev A live UPV4 Wise settlement: Base block 61620404, tx
    /// 0xbe2b66d3314fc36f55ae26a005ce3f8261ec95129908a2224efc4dbf3ec0f242.
    uint256 internal constant LIVE_SETTLEMENT_BLOCK = 61620404;
    bytes32 internal constant LIVE_METHOD = 0x554a007c2217df766b977723b276671aee5ebb4adaea0edb6433c88b3e61dac5;
    bytes32 internal constant LIVE_PAYMENT_ID = 0xa1c9614d78e15f706d7718529c37aad92402f6074d6a0019ce9296b8bfc0f4a4;
    bytes32 internal constant LIVE_NULLIFIER = 0x7bb0901b2d35bf3976a0be1049d454486c91982fea7a3fdd92c2b4476d42c617;
    bytes32 internal constant LIVE_INTENT = 0x233d36355f8ded68e8df5e934ac7d3053bfb8aa76aa8578e8773aa573ff3f759;

    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant FRESH_INTENT = keccak256("upv5-base-fork-intent");
    bytes32 internal constant FRESH_PAYMENT_ID = keccak256("upv5-base-fork-payment");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("upv5-base-fork-payee");
    uint256 internal constant PAYMENT_AMOUNT = 5000;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1e18;
    uint256 internal constant SIGNAL_TIMESTAMP = 1_795_399_000;

    INullifierRegistryV2 internal nullifierRegistryV2 = INullifierRegistryV2(NULLIFIER_REGISTRY_V2);
    NullifierRegistryV3 internal nullifierRegistryV3;

    modifier onBaseFork() {
        string memory url = vm.envOr("BASE_FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
        } else {
            vm.createSelectFork(url);
            emit log_named_uint("Base fork block", block.number);
            assertEq(block.chainid, 8453);
            assertGt(block.number, LIVE_SETTLEMENT_BLOCK);
            nullifierRegistryV3 = new NullifierRegistryV3(nullifierRegistryV2);
            _;
        }
    }

    /// @dev The pinned pair comes from a live UPV4 settlement, so it also pins the frozen nullifier formula.
    function test_LiveV2BindingStaysAuthoritativeThroughV3() public onBaseFork {
        assertEq(LIVE_METHOD, keccak256("wise"));
        assertEq(LIVE_NULLIFIER, keccak256(abi.encodePacked(LIVE_METHOD, LIVE_PAYMENT_ID)));
        assertEq(address(nullifierRegistryV2.legacyNullifierRegistry()), NULLIFIER_REGISTRY_V1);
        assertEq(nullifierRegistryV2.intentHashByNullifier(LIVE_NULLIFIER), LIVE_INTENT);
        assertEq(address(nullifierRegistryV3.predecessor()), NULLIFIER_REGISTRY_V2);

        assertTrue(nullifierRegistryV3.isNullified(LIVE_NULLIFIER));
        assertEq(nullifierRegistryV3.intentHashByNullifier(LIVE_NULLIFIER), LIVE_INTENT);

        nullifierRegistryV3.addWritePermission(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(INullifierRegistryV3.NullifierAlreadyExists.selector, LIVE_NULLIFIER)
        );
        nullifierRegistryV3.addNullifier(LIVE_NULLIFIER, FRESH_INTENT);
    }

    function test_FreshNullifierWritesToV3AndStaysInvisibleToV2() public onBaseFork {
        bytes32 freshNullifier = keccak256(abi.encodePacked(LIVE_METHOD, FRESH_PAYMENT_ID));
        assertFalse(nullifierRegistryV3.isNullified(freshNullifier));

        nullifierRegistryV3.addWritePermission(address(this));
        vm.expectEmit(true, true, true, true, address(nullifierRegistryV3));
        emit NullifierAdded(freshNullifier, FRESH_INTENT, address(this));
        nullifierRegistryV3.addNullifier(freshNullifier, FRESH_INTENT);

        assertTrue(nullifierRegistryV3.isNullified(freshNullifier));
        assertEq(nullifierRegistryV3.intentHashByNullifier(freshNullifier), FRESH_INTENT);
        assertFalse(nullifierRegistryV2.isNullified(freshNullifier));
        assertEq(nullifierRegistryV2.intentHashByNullifier(freshNullifier), bytes32(0));
    }

    /// @dev UPV5 on V3 with the live attestation verifier, given a fork-only witness. A registered harness stands
    /// in for OrchestratorV4, since the replay check needs no live intent.
    function test_UPV5OnV3RejectsAPayloadReplayingTheLiveNullifier() public onBaseFork {
        MultiAttestationVerifier attestationVerifier = MultiAttestationVerifier(MULTI_ATTESTATION_VERIFIER);
        assertEq(attestationVerifier.requiredSignatures(), 1);
        address forkWitness = vm.addr(WITNESS_KEY);
        vm.prank(attestationVerifier.owner());
        attestationVerifier.addWitness(forkWitness);

        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        UnifiedPaymentVerifierV4V4CallerHarness caller = new UnifiedPaymentVerifierV4V4CallerHarness();
        orchestratorRegistry.addOrchestrator(address(caller));
        UnifiedPaymentVerifierV5 upv5 = new UnifiedPaymentVerifierV5(
            orchestratorRegistry, INullifierRegistryV2(address(nullifierRegistryV3)), attestationVerifier
        );
        nullifierRegistryV3.addWritePermission(address(upv5));
        upv5.addPaymentMethod(LIVE_METHOD);
        caller.setIntent(FRESH_INTENT, _intent());

        bytes memory replay = _proof(upv5.DOMAIN_SEPARATOR(), LIVE_PAYMENT_ID, LIVE_NULLIFIER);
        vm.expectRevert("Nullifier has already been used");
        caller.verifyPayment(upv5, IPaymentVerifierV2.VerifyPaymentData(FRESH_INTENT, replay, ""));

        bytes32 freshNullifier = keccak256(abi.encodePacked(LIVE_METHOD, FRESH_PAYMENT_ID));
        bytes memory fresh = _proof(upv5.DOMAIN_SEPARATOR(), FRESH_PAYMENT_ID, freshNullifier);
        caller.verifyPayment(upv5, IPaymentVerifierV2.VerifyPaymentData(FRESH_INTENT, fresh, ""));
        assertEq(nullifierRegistryV3.intentHashByNullifier(freshNullifier), FRESH_INTENT);
        assertFalse(nullifierRegistryV2.isNullified(freshNullifier));
    }

    function _intent() internal view returns (IOrchestratorV4.Intent memory) {
        return IOrchestratorV4.Intent({
            owner: address(this),
            to: address(this),
            escrow: address(1),
            depositId: 0,
            amount: INTENT_AMOUNT,
            timestamp: SIGNAL_TIMESTAMP,
            paymentMethod: LIVE_METHOD,
            fiatCurrency: USD,
            conversionRate: CONVERSION_RATE,
            payeeId: PAYEE,
            referralFees: new IReferralFee.ReferralFee[](0),
            payerCommitment: "",
            takerWhitelisted: false,
            arbitrator: address(0)
        });
    }

    function _proof(bytes32 domainSeparator, bytes32 paymentId, bytes32 nullifier)
        internal
        view
        returns (bytes memory)
    {
        bytes32[] memory nullifiers = new bytes32[](1);
        nullifiers[0] = nullifier;
        bytes memory data = abi.encode(
            IPaymentVerifierV2.PaymentDetails({
                method: LIVE_METHOD,
                payeeId: PAYEE,
                amount: PAYMENT_AMOUNT,
                currency: USD,
                timestamp: (SIGNAL_TIMESTAMP + 60) * 1000,
                paymentId: paymentId
            }),
            IPaymentVerifierV2.IntentSnapshot({
                intentHash: FRESH_INTENT,
                amount: INTENT_AMOUNT,
                paymentMethod: LIVE_METHOD,
                fiatCurrency: USD,
                payeeDetails: PAYEE,
                conversionRate: CONVERSION_RATE,
                signalTimestamp: SIGNAL_TIMESTAMP,
                timestampBuffer: 0,
                payerCommitmentHash: bytes32(0),
                owner: address(this)
            }),
            abi.encode(uint256(0)),
            nullifiers
        );
        bytes32 dataHash = keccak256(data);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                FRESH_INTENT,
                INTENT_AMOUNT,
                dataHash
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(WITNESS_KEY, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifierV5.PaymentAttestation({
                intentHash: FRESH_INTENT,
                releaseAmount: INTENT_AMOUNT,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }
}
