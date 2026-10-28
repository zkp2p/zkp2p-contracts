// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
import {IPaymentVerifierV2} from "contracts/interfaces/IPaymentVerifierV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {UnifiedPaymentVerifierV4} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV4.sol";

/// @notice Opt-in Base rehearsal of the exact lane-47 Safe batch bytes, outside coverage's deterministic tree.
contract UnifiedPaymentVerifierV4BaseCutoverTest is Test {
    address internal constant SAFE = 0x0bC26FF515411396DD588Abd6Ef6846E04470227;
    address internal constant DEPLOYER = 0x41123d6419C7b8e44157f6F3b0088442116641eC;
    address internal constant PVR = 0x2b82D24437ff66Fb173eabDfD67ee2ACeb8bEb1e;
    address internal constant NRV2 = 0x5455e761b866dfa6A2f5Dc6d6525825bf9C09aeB;
    address internal constant ORCHESTRATOR_REGISTRY = 0xBe9fED15ED7A4B915C03EFcEcb9662739C3382A9;
    address internal constant MAV = 0x9Fe920b24e50e6a6362BA71a1BeB502A99c402d5;
    address internal constant UPV3 = 0xC6F4a193576C60892a47e111Bb5706c30162502B;
    address internal constant UPV4 = 0x7bE50E6206a9b3AdF36dbEAFac0e45Cc03A72048;
    address internal constant O3 = 0x014025fDE093f8701d86e9f38e2C3a9b779cb5c7;
    address internal constant LIFECYCLE_HOOK = 0x5Dd6C675a7406fE8C9f0D93394a36fd6e8c50031;
    address internal constant ESCROW = 0x777777779d229cdF3110e9de47943791c26300Ef;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant DEFAULT_FORK_BLOCK = 53210521;
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant DEPOSIT_AMOUNT = 1_000e6;
    uint256 internal constant INTENT_AMOUNT = 50e6;
    uint256 internal constant CONVERSION_RATE = 1e18;
    bytes32 internal constant METHOD = keccak256("zelle");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("upv4-base-fork-payee");
    bytes32 internal constant P0 = keccak256("upv4-base-fork-payment-0");
    bytes32 internal constant P1 = keccak256("upv4-base-fork-payment-1");
    bytes32 internal constant P2 = keccak256("upv4-base-fork-payment-2");

    PaymentVerifierRegistry internal registry = PaymentVerifierRegistry(PVR);
    NullifierRegistryV2 internal nullifiers = NullifierRegistryV2(NRV2);
    OrchestratorV3 internal orchestrator = OrchestratorV3(O3);
    EscrowV2 internal escrow = EscrowV2(ESCROW);
    IERC20 internal token = IERC20(USDC);
    UnifiedPaymentVerifierV4 internal upv4 = UnifiedPaymentVerifierV4(UPV4);
    bytes32[] internal methodsBefore;
    bytes32[][] internal currenciesBefore;
    uint256 internal depositId;

    modifier onBaseFork() {
        string memory url = vm.envOr("BASE_FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
        } else {
            uint256 forkBlock = vm.envOr("BASE_FORK_BLOCK", DEFAULT_FORK_BLOCK);
            vm.createSelectFork(url, forkBlock);
            emit log_named_uint("Base fork block", block.number);
            _snapshotPreState();
            _;
        }
    }

    function test_CutoverFulfilsThroughUPV4AndRollbackRestoresUPV3() public onBaseFork {
        _prepareDepositAndWitness();
        bytes32 intent0 = _signal(0);
        _fulfillAndAssert(intent0, P0, _proofV3(intent0, P0));

        _assertUPV4();
        _applyBatch("cutover");
        _assertRoutes(address(upv4));
        _assertWriters(true, true);
        _assertUPV4();

        bytes32 intent1 = _signal(1);
        _assertReplayRejected(intent1, intent0, P0, _proofV4(intent1, P0));
        _fulfillAndAssert(intent1, P1, _proofV4(intent1, P1));

        _applyBatch("rollback");
        _assertRoutes(UPV3);
        _assertWriters(true, true);
        _assertUPV4();

        bytes32 intent2 = _signal(2);
        _assertReplayRejected(intent2, intent1, P1, _proofV3(intent2, P1));
        _fulfillAndAssert(intent2, P2, _proofV3(intent2, P2));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, DEPOSIT_AMOUNT - 3 * INTENT_AMOUNT);
    }

    function test_Upv3WriterRemovalLeavesUPV4SoleWriter() public onBaseFork {
        _prepareDepositAndWitness();
        _assertUPV4();
        _applyBatch("cutover");
        _assertRoutes(address(upv4));
        _assertWriters(true, true);
        _applyBatch("upv3-writer-removal");
        _assertRoutes(address(upv4));
        _assertWriters(false, true);
        _assertUPV4();

        bytes32 intent = _signal(0);
        _fulfillAndAssert(intent, P0, _proofV4(intent, P0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, DEPOSIT_AMOUNT - INTENT_AMOUNT);
    }

    function test_CutoverBatchShape() public onBaseFork {
        _assertUPV4();
        (address[] memory targets, bytes[] memory data) = _batch("cutover");
        assertEq(targets.length, 27);
        _assertWriterCall(targets[0], data[0], NullifierRegistryV2.addWritePermission.selector, address(upv4));
        _assertRouteCalls(targets, data, 1, address(upv4));

        (targets, data) = _batch("rollback");
        assertEq(targets.length, 26);
        _assertRouteCalls(targets, data, 0, UPV3);

        (targets, data) = _batch("upv3-writer-removal");
        assertEq(targets.length, 1);
        _assertWriterCall(targets[0], data[0], NullifierRegistryV2.removeWritePermission.selector, UPV3);
    }

    function _snapshotPreState() internal {
        assertEq(block.chainid, 8453);
        assertEq(registry.owner(), SAFE);
        assertEq(nullifiers.owner(), SAFE);
        assertEq(MultiAttestationVerifier(MAV).owner(), SAFE);
        assertEq(MultiAttestationVerifier(MAV).requiredSignatures(), 1);
        assertEq(address(orchestrator.paymentVerifierRegistry()), PVR);
        assertTrue(orchestrator.allowMultipleIntents());
        assertEq(orchestrator.protocolFee(), 0);
        assertEq(address(orchestrator.lifecycleHook()), LIFECYCLE_HOOK);
        assertTrue(orchestrator.escrowRegistry().isWhitelistedEscrow(ESCROW));
        assertTrue(IOrchestratorRegistry(ORCHESTRATOR_REGISTRY).isOrchestrator(O3));
        assertEq(address(UnifiedPaymentVerifierV3(UPV3).nullifierRegistry()), NRV2);
        assertEq(address(UnifiedPaymentVerifierV3(UPV3).attestationVerifier()), MAV);
        assertEq(address(UnifiedPaymentVerifierV3(UPV3).orchestratorRegistry()), ORCHESTRATOR_REGISTRY);
        methodsBefore = registry.getPaymentMethods();
        assertEq(methodsBefore.length, 13);
        for (uint256 index; index < methodsBefore.length; ++index) {
            currenciesBefore.push(registry.getCurrencies(methodsBefore[index]));
        }
        _assertRoutes(UPV3);
        _assertWriters(true, false);
    }

    function _assertRoutes(address verifier) internal view {
        assertEq(registry.getPaymentMethods(), methodsBefore);
        for (uint256 index; index < methodsBefore.length; ++index) {
            assertEq(registry.getVerifier(methodsBefore[index]), verifier);
            assertEq(registry.getCurrencies(methodsBefore[index]), currenciesBefore[index]);
        }
    }

    function _assertWriters(bool hasUPV3, bool hasUPV4) internal view {
        address[] memory expected = new address[]((hasUPV3 ? 1 : 0) + (hasUPV4 ? 1 : 0));
        if (hasUPV3) expected[0] = UPV3;
        if (hasUPV4) expected[hasUPV3 ? 1 : 0] = address(upv4);
        assertEq(nullifiers.getWriters(), expected);
        assertEq(nullifiers.isWriter(UPV3), hasUPV3);
        assertEq(nullifiers.isWriter(address(upv4)), hasUPV4);
    }

    function _assertUPV4() internal view {
        assertGt(UPV4.code.length, 0);
        assertEq(vm.computeCreateAddress(DEPLOYER, 117), UPV4);
        assertEq(upv4.owner(), SAFE);
        assertEq(upv4.getPaymentMethods(), methodsBefore);
        assertEq(address(upv4.orchestratorRegistry()), ORCHESTRATOR_REGISTRY);
        assertEq(address(upv4.nullifierRegistry()), NRV2);
        assertEq(address(upv4.attestationVerifier()), MAV);
    }

    function _batch(string memory kind) internal returns (address[] memory targets, bytes[] memory data) {
        string[] memory command = new string[](6);
        command[0] = "node_modules/.bin/ts-node";
        command[1] = "--transpile-only";
        command[2] = "scripts/upv4SafeBatches.ts";
        command[3] = "ffi";
        command[4] = kind;
        command[5] = vm.toString(address(upv4));
        (targets, data) = abi.decode(vm.ffi(command), (address[], bytes[]));
        assertEq(targets.length, data.length);
        for (uint256 index; index < targets.length; ++index) assertTrue(targets[index] == PVR || targets[index] == NRV2);
    }

    function _applyBatch(string memory kind) internal {
        (address[] memory targets, bytes[] memory data) = _batch(kind);
        for (uint256 index; index < targets.length; ++index) {
            vm.prank(SAFE);
            (bool success, bytes memory result) = targets[index].call(data[index]);
            assertTrue(success, string.concat(kind, " call ", vm.toString(index), ": ", vm.toString(result)));
        }
    }

    function _assertWriterCall(address target, bytes memory data, bytes4 selector, address writer) internal pure {
        assertEq(target, NRV2);
        assertEq(bytes4(data), selector);
        assertEq(abi.decode(_args(data), (address)), writer);
    }

    function _assertRouteCalls(address[] memory targets, bytes[] memory data, uint256 offset, address verifier)
        internal view
    {
        for (uint256 index; index < 13; ++index) {
            assertEq(targets[offset + index], PVR);
            _assertRemoveCall(data[offset + index], methodsBefore[12 - index]);
            assertEq(targets[offset + 13 + index], PVR);
            _assertAddCall(data[offset + 13 + index], methodsBefore[index], verifier, currenciesBefore[index]);
        }
    }

    function _assertRemoveCall(bytes memory data, bytes32 method) internal pure {
        assertEq(bytes4(data), PaymentVerifierRegistry.removePaymentMethod.selector);
        assertEq(abi.decode(_args(data), (bytes32)), method);
    }

    function _assertAddCall(bytes memory data, bytes32 method, address verifier, bytes32[] memory currencies)
        internal pure
    {
        assertEq(bytes4(data), PaymentVerifierRegistry.addPaymentMethod.selector);
        (bytes32 actualMethod, address actualVerifier, bytes32[] memory actualCurrencies) =
            abi.decode(_args(data), (bytes32, address, bytes32[]));
        assertEq(actualMethod, method);
        assertEq(actualVerifier, verifier);
        assertEq(actualCurrencies, currencies);
    }

    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 index; index < args.length; ++index) args[index] = data[index + 4];
    }

    function _prepareDepositAndWitness() internal {
        address witness = vm.addr(WITNESS_KEY);
        vm.prank(SAFE);
        MultiAttestationVerifier(MAV).addWitness(witness);

        address depositor = makeAddr("upv4-base-fork-depositor");
        deal(USDC, depositor, DEPOSIT_AMOUNT);
        assertEq(token.balanceOf(depositor), DEPOSIT_AMOUNT);
        uint256 escrowBalance = token.balanceOf(ESCROW);
        depositId = escrow.depositCounter();
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] = IEscrowV2.DepositPaymentMethodData(address(0), PAYEE, "");
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency(
            USD, CONVERSION_RATE, IEscrowV2.OracleRateConfig(address(0), "", 0, 0)
        );
        vm.startPrank(depositor);
        token.approve(ESCROW, DEPOSIT_AMOUNT);
        escrow.createDeposit(IEscrowV2.CreateDepositParams(
            token, DEPOSIT_AMOUNT, IEscrowV2.Range(1e6, 100e6), methods, methodData, currencies,
            address(0), address(0), true
        ));
        vm.stopPrank();
        assertEq(token.balanceOf(depositor), 0);
        assertEq(token.balanceOf(ESCROW) - escrowBalance, DEPOSIT_AMOUNT);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, DEPOSIT_AMOUNT);
        assertEq(escrow.getDepositGatingService(depositId, METHOD), address(0));
        IntentLifecycleHookV1 hook = IntentLifecycleHookV1(LIFECYCLE_HOOK);
        assertFalse(hook.whitelistPolicy().enabled(ESCROW, depositId, METHOD));
        assertFalse(hook.disputeProtectionPolicy().isDisputeProtectionEnabled(ESCROW, depositId, METHOD));
    }

    function _signal(uint256 sequence) internal returns (bytes32 intentHash) {
        address taker = makeAddr(string.concat("upv4-base-fork-taker-", vm.toString(sequence)));
        address recipient = makeAddr(string.concat("upv4-base-fork-recipient-", vm.toString(sequence)));
        vm.prank(taker);
        orchestrator.signalIntent(IOrchestratorV3.SignalIntentParams(
            ESCROW, depositId, INTENT_AMOUNT, recipient, METHOD, USD, CONVERSION_RATE,
            new IReferralFee.ReferralFee[](0), "", 0, IPostIntentHookV2(address(0)), "", ""
        ));
        bytes32[] memory intents = orchestrator.getAccountIntents(taker);
        assertEq(intents.length, 1);
        intentHash = intents[0];
        assertEq(orchestrator.getIntent(intentHash).owner, taker);
        assertEq(orchestrator.getIntent(intentHash).to, recipient);
        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), LIFECYCLE_HOOK);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, INTENT_AMOUNT);
    }

    function _proofV3(bytes32 intentHash, bytes32 paymentId) internal view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        bytes memory data = abi.encode(
            UnifiedPaymentVerifierV3.PaymentDetails(METHOD, PAYEE, INTENT_AMOUNT / 10000, USD, block.timestamp * 1000, paymentId),
            UnifiedPaymentVerifierV3.IntentSnapshot(
                intentHash, intent.amount, METHOD, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0
            )
        );
        return _signedProof(intentHash, data, UnifiedPaymentVerifierV3(UPV3).DOMAIN_SEPARATOR());
    }

    function _proofV4(bytes32 intentHash, bytes32 paymentId) internal view returns (bytes memory) {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        bytes memory data = abi.encode(
            IPaymentVerifierV2.PaymentDetails(METHOD, PAYEE, INTENT_AMOUNT / 10000, USD, block.timestamp * 1000, paymentId),
            IPaymentVerifierV2.IntentSnapshot(
                intentHash, intent.amount, METHOD, USD, PAYEE, CONVERSION_RATE, intent.timestamp, 0, bytes32(0), intent.owner
            ),
            bytes("")
        );
        return _signedProof(intentHash, data, upv4.DOMAIN_SEPARATOR());
    }

    function _signedProof(bytes32 intentHash, bytes memory data, bytes32 domain) internal view returns (bytes memory) {
        bytes32 dataHash = keccak256(data);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", domain, keccak256(abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                intentHash, INTENT_AMOUNT, dataHash
            ))
        ));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        // The outer attestation ABI is identical in UPV3 and UPV4; their payloads and domains differ.
        return abi.encode(UnifiedPaymentVerifierV4.PaymentAttestation(intentHash, INTENT_AMOUNT, dataHash, signatures, data, ""));
    }

    function _fulfillAndAssert(bytes32 intentHash, bytes32 paymentId, bytes memory proof) internal {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        uint256 recipientBalance = token.balanceOf(intent.to);
        uint256 escrowBalance = token.balanceOf(ESCROW);
        uint256 remaining = escrow.getDeposit(depositId).remainingDeposits;
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
        assertEq(token.balanceOf(intent.to) - recipientBalance, INTENT_AMOUNT);
        assertEq(escrowBalance - token.balanceOf(ESCROW), INTENT_AMOUNT);
        assertEq(orchestrator.getAccountIntents(intent.owner).length, 0);
        assertEq(orchestrator.getIntent(intentHash).owner, address(0));
        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), address(0));
        assertEq(escrow.getDepositIntentHashes(depositId).length, 0);
        assertEq(escrow.getDeposit(depositId).outstandingIntentAmount, 0);
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remaining);
        _assertNullifier(paymentId, intentHash);
    }

    function _assertReplayRejected(bytes32 intentHash, bytes32 originalIntent, bytes32 paymentId, bytes memory proof) internal {
        IOrchestratorV3.Intent memory intent = orchestrator.getIntent(intentHash);
        IEscrowV2.Deposit memory deposit = escrow.getDeposit(depositId);
        uint256 recipientBalance = token.balanceOf(intent.to);
        uint256 escrowBalance = token.balanceOf(ESCROW);
        vm.expectRevert("Nullifier has already been used");
        orchestrator.fulfillIntent(IOrchestratorV3.FulfillIntentParams(proof, intentHash, "", ""));
        assertEq(abi.encode(orchestrator.getIntent(intentHash)), abi.encode(intent));
        assertEq(abi.encode(escrow.getDeposit(depositId)), abi.encode(deposit));
        assertEq(token.balanceOf(intent.to), recipientBalance);
        assertEq(token.balanceOf(ESCROW), escrowBalance);
        assertEq(nullifiers.nullifierByIntentHash(intentHash), bytes32(0));
        _assertNullifier(paymentId, originalIntent);
    }

    function _assertNullifier(bytes32 paymentId, bytes32 intentHash) internal view {
        bytes32 nullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        assertTrue(nullifiers.isNullified(nullifier));
        assertEq(nullifiers.intentHashByNullifier(nullifier), intentHash);
        assertEq(nullifiers.nullifierByIntentHash(intentHash), nullifier);
    }
}
