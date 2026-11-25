// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DisputeProtectionPolicyV3} from "contracts/hooks/DisputeProtectionPolicyV3.sol";
import {IDisputeProtectionPolicyV3 as P} from "contracts/interfaces/IDisputeProtectionPolicyV3.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {IReceiptVerifier} from "contracts/interfaces/IReceiptVerifier.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {NullifierRegistryV3} from "contracts/registries/NullifierRegistryV3.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {DisputeVerifierV2} from "contracts/unifiedVerifier/DisputeVerifierV2.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {ReceiptVerifier} from "contracts/unifiedVerifier/ReceiptVerifier.sol";
import {BlacklistTokenMock} from "../../mocks/BlacklistTokenMock.sol";
import {PayoutHookTokenMock} from "../../mocks/PayoutHookTokenMock.sol";
import {ReentrantPayoutRecipientMock} from "../../mocks/ReentrantPayoutRecipientMock.sol";

/// @notice Early release on enclave-signed receipt confirmations, with real witness signatures and nullifier binding.
contract DisputeProtectionPolicyV3EarlyReleaseTest is Test {
    event ProtectionReleased(bytes32 indexed intentHash);
    event DisputeResolved(
        bytes32 indexed intentHash,
        address indexed stakeOwner,
        address indexed depositor,
        uint256 compensatedAmount,
        bytes32 disputeId
    );
    event ReceiptConfirmed(bytes32 indexed intentHash, uint64 releaseAt);
    event ReceiptSkipped(bytes32 indexed intentHash, P.SkipReason reason);
    event ReceiptVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event ReceiptPayoutFailed(bytes32 indexed intentHash);
    event RemainderRelocked(bytes32 indexed intentHash, address indexed owner, uint256 amount, uint64 maturesAt);

    uint64 internal constant START = 1_000_000;
    uint64 internal constant WINDOW = 14 days;
    uint64 internal constant MATURES_AT = START + WINDOW;
    uint256 internal constant GROSS = 100e6;
    uint256 internal constant NET = 99.05e6;
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    uint256 internal constant IMPOSTOR_KEY = 0xBAD;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant SHARE = keccak256("PEER_RELEASE_SHARE");
    bytes32 internal constant ID = keccak256("intent");
    bytes32 internal constant ID2 = keccak256("second");
    bytes32 internal constant ID3 = keccak256("third");
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);
    address internal constant STRANGER = address(0x44);
    string internal constant NOT_ENOUGH_SIGNATURES = "ThresholdSigVerifierUtils: Not enough valid witness signatures";
    string internal constant REENTRANT_CALL = "ReentrancyGuard: reentrant call";

    IERC20 internal token;
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV3 internal policy;
    DisputeVerifierV2 internal disputeVerifier;
    ReceiptVerifier internal receiptVerifier;
    MultiAttestationVerifier internal witnesses;
    NullifierRegistry internal disputes;
    NullifierRegistryV2 internal predecessor;
    NullifierRegistryV3 internal payments;
    OrchestratorRegistry internal orchestrators;

    function setUp() public {
        vm.warp(START);
        _deploy(new USDCMock(10_000_000e6, "USDC", "USDC"));
    }

    /* ============ Harness ============ */

    function _deploy(IERC20 _token) internal {
        token = _token;
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(WITNESS_KEY);
        witnesses = new MultiAttestationVerifier(signers, 1);
        vault = new StakeVaultV2(address(this), token);
        predecessor = new NullifierRegistryV2(new NullifierRegistry());
        payments = new NullifierRegistryV3(predecessor);
        payments.addWritePermission(address(this));
        disputes = new NullifierRegistry();
        disputeVerifier = new DisputeVerifierV2(address(this), payments, witnesses);
        receiptVerifier = new ReceiptVerifier(address(this), payments, witnesses);
        orchestrators = new OrchestratorRegistry();
        orchestrators.addOrchestrator(address(this));
        policy = new DisputeProtectionPolicyV3(
            address(this), vault, disputeVerifier, receiptVerifier, disputes, orchestrators
        );
        disputes.addWritePermission(address(policy));
        vault.setController(address(policy), true);
    }

    function _context(bytes32 id, address recipient) internal view returns (S.SettlementContext memory) {
        return S.SettlementContext(
            id, address(token), TAKER, recipient, DEPOSITOR, METHOD, GROSS, NET, abi.encode(uint256(WINDOW))
        );
    }

    function _stake(address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _settleStaked(bytes32 id) internal {
        _stake(TAKER, GROSS);
        assertEq(policy.settleIntent(_context(id, RECIPIENT)), address(0));
        payments.addNullifier(_nullifier(id), id);
    }

    function _settleDeferred(bytes32 id, address recipient) internal {
        S.SettlementContext memory context = _context(id, recipient);
        assertEq(policy.settleIntent(context), address(vault));
        token.transfer(address(vault), NET);
        policy.onDeferredPayoutFunded(context);
        payments.addNullifier(_nullifier(id), id);
    }

    function _nullifier(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode("payment", id));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes[] memory signatures) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
    }

    function _receipt(bytes32 id, uint64 releaseAt) internal view returns (IReceiptVerifier.ReceiptAttestation memory) {
        return _receipt(id, releaseAt, METHOD, _nullifier(id), WITNESS_KEY);
    }

    function _receipt(bytes32 id, uint64 releaseAt, bytes32 method, bytes32 nullifier, uint256 key)
        internal
        view
        returns (IReceiptVerifier.ReceiptAttestation memory receipt)
    {
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = nullifier;
        bytes memory data = abi.encode(method, candidates);
        receipt = IReceiptVerifier.ReceiptAttestation({
            intentHash: id, releaseAt: releaseAt, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
        receipt.signatures = _sign(key, receiptVerifier.hashReceiptAttestation(receipt));
    }

    function _batch(IReceiptVerifier.ReceiptAttestation memory first)
        internal
        pure
        returns (IReceiptVerifier.ReceiptAttestation[] memory receipts)
    {
        receipts = new IReceiptVerifier.ReceiptAttestation[](1);
        receipts[0] = first;
    }

    function _batch(
        IReceiptVerifier.ReceiptAttestation memory first,
        IReceiptVerifier.ReceiptAttestation memory second,
        IReceiptVerifier.ReceiptAttestation memory third
    ) internal pure returns (IReceiptVerifier.ReceiptAttestation[] memory receipts) {
        receipts = new IReceiptVerifier.ReceiptAttestation[](3);
        receipts[0] = first;
        receipts[1] = second;
        receipts[2] = third;
    }

    function _dispute(bytes32 id, uint256 claim) internal view returns (IDisputeVerifier.DisputeAttestation memory dispute) {
        bytes32[] memory candidates = new bytes32[](1);
        candidates[0] = _nullifier(id);
        bytes memory data = abi.encode(
            IDisputeVerifier.DisputeDetails(METHOD, keccak256("payment-id"), keccak256(abi.encode("dispute", id)), claim, SHARE),
            candidates
        );
        dispute = IDisputeVerifier.DisputeAttestation(id, keccak256(data), new bytes[](0), data);
        dispute.signatures = _sign(WITNESS_KEY, disputeVerifier.hashDisputeAttestation(dispute));
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }

    function _releaseAt(bytes32 id) internal view returns (uint64) {
        return policy.getProtection(id).releaseAt;
    }

    function _isOpen(bytes32 id) internal view returns (bool) {
        return policy.getProtection(id).depositor != address(0);
    }

    function _assertNothingStranded() internal view {
        assertEq(token.balanceOf(address(vault)), vault.totalAccounted());
        assertEq(token.balanceOf(address(policy)), 0);
    }

    /* ============ Confirmation ============ */

    function test_BatchOfThreeFreshReceiptsConfirmsAll() public {
        _settleStaked(ID);
        _settleDeferred(ID2, RECIPIENT);
        _settleDeferred(ID3, RECIPIENT);
        uint64 releaseAt = START + 3 days;
        IReceiptVerifier.ReceiptAttestation[] memory receipts =
            _batch(_receipt(ID, releaseAt), _receipt(ID2, releaseAt + 1), _receipt(ID3, releaseAt + 2));

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID, releaseAt);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID2, releaseAt + 1);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID3, releaseAt + 2);
        vm.prank(STRANGER);
        policy.confirmReceipts(receipts);

        assertEq(_releaseAt(ID), releaseAt);
        assertEq(_releaseAt(ID2), releaseAt + 1);
        assertEq(_releaseAt(ID3), releaseAt + 2);
        P.Protection memory protection = policy.getProtection(ID2);
        assertEq(protection.depositor, DEPOSITOR);
        assertTrue(protection.deferredPayout);
        assertEq(protection.paymentMethod, METHOD);
        assertEq(protection.releaseAmount, GROSS);
        assertEq(vault.lockedStake(TAKER), GROSS);
        assertEq(token.balanceOf(RECIPIENT), 0);
    }

    function test_PastReleaseAtPaysOutInTheSameCall() public {
        _settleStaked(ID);
        _settleDeferred(ID2, RECIPIENT);
        vm.warp(START + 2 days);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, START + 1 days);
        receipts[1] = _receipt(ID2, START + 2 days);

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID, START + 1 days);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ProtectionReleased(ID);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID2, START + 2 days);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ProtectionReleased(ID2);
        policy.confirmReceipts(receipts);

        assertFalse(_isOpen(ID));
        assertFalse(_isOpen(ID2));
        assertEq(vault.lockedStake(TAKER), 0);
        assertEq(vault.freeStake(TAKER), GROSS);
        assertEq(token.balanceOf(RECIPIENT), NET);
        (address lockOwner,,) = vault.locks(ID2);
        assertEq(lockOwner, address(0));
        _assertNothingStranded();
    }

    function test_FutureReleaseAtLetsReleasePayBeforeMaturity() public {
        _settleDeferred(ID, RECIPIENT);
        _settleStaked(ID2);
        uint64 releaseAt = START + 3 days;
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, releaseAt);
        receipts[1] = _receipt(ID2, releaseAt);
        policy.confirmReceipts(receipts);
        assertTrue(_isOpen(ID));

        vm.warp(releaseAt - 1);
        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, releaseAt, releaseAt - 1));
        policy.release(_ids(ID));

        vm.warp(releaseAt);
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ID;
        ids[1] = ID2;
        vm.prank(STRANGER);
        policy.release(ids);

        assertEq(token.balanceOf(RECIPIENT), NET);
        assertEq(vault.freeStake(TAKER), GROSS);
        assertFalse(_isOpen(ID));
        assertFalse(_isOpen(ID2));
        _assertNothingStranded();
    }

    function test_ReleaseAtAfterMaturityStillReleasesAtMaturity() public {
        _settleDeferred(ID, RECIPIENT);
        policy.confirmReceipts(_batch(_receipt(ID, MATURES_AT + 30 days)));
        assertEq(_releaseAt(ID), MATURES_AT + 30 days);

        vm.warp(MATURES_AT - 1);
        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, MATURES_AT, MATURES_AT - 1));
        policy.release(_ids(ID));

        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        assertEq(token.balanceOf(RECIPIENT), NET);
        assertFalse(_isOpen(ID));
    }

    /// @dev A receipt for an already matured protection with a future releaseAt is stored; release pays at maturity.
    function test_ReceiptOnMaturedProtectionWithFutureReleaseAtIsStored() public {
        _settleDeferred(ID, RECIPIENT);
        vm.warp(MATURES_AT + 1);
        policy.confirmReceipts(_batch(_receipt(ID, MATURES_AT + 2)));
        assertEq(_releaseAt(ID), MATURES_AT + 2);

        policy.release(_ids(ID));
        assertEq(token.balanceOf(RECIPIENT), NET);
    }

    /* ============ Skips ============ */

    /// @dev Review focus 1: one fresh, one stale and one already confirmed receipt in one batch.
    function test_MixedBatchConfirmsFreshAndSkipsStaleAndConfirmed() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        _settleDeferred(ID3, RECIPIENT);
        policy.confirmReceipts(_batch(_receipt(ID, START + 5 days)));
        policy.submitDispute(_dispute(ID2, GROSS));
        assertFalse(_isOpen(ID2));

        vm.recordLogs();
        policy.confirmReceipts(
            _batch(_receipt(ID, START + 1 days), _receipt(ID2, START + 1 days), _receipt(ID3, START + 2 days))
        );

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 3);
        assertEq(logs[0].topics[0], ReceiptSkipped.selector);
        assertEq(logs[0].topics[1], ID);
        assertEq(abi.decode(logs[0].data, (uint8)), uint8(P.SkipReason.ALREADY_CONFIRMED));
        assertEq(logs[1].topics[0], ReceiptSkipped.selector);
        assertEq(logs[1].topics[1], ID2);
        assertEq(abi.decode(logs[1].data, (uint8)), uint8(P.SkipReason.STALE));
        assertEq(logs[2].topics[0], ReceiptConfirmed.selector);
        assertEq(logs[2].topics[1], ID3);
        assertEq(abi.decode(logs[2].data, (uint64)), START + 2 days);
        for (uint256 index; index < logs.length; ++index) assertEq(logs[index].emitter, address(policy));

        assertEq(_releaseAt(ID), START + 5 days);
        assertEq(_releaseAt(ID3), START + 2 days);
    }

    function test_ReceiptForReleasedOrUnknownProtectionIsStale() public {
        _settleStaked(ID);
        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, START + 1 days);
        receipts[1] = _receipt(ID2, START + 1 days);

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptSkipped(ID, P.SkipReason.STALE);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptSkipped(ID2, P.SkipReason.STALE);
        policy.confirmReceipts(receipts);
    }

    /// @dev A repeated entry is skipped: already confirmed while held, stale once the first entry paid out.
    function test_DuplicateEntriesInOneBatch() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation memory held = _receipt(ID, START + 1 days);
        IReceiptVerifier.ReceiptAttestation memory paid = _receipt(ID2, START);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](4);
        receipts[0] = held;
        receipts[1] = held;
        receipts[2] = paid;
        receipts[3] = paid;

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID, START + 1 days);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptSkipped(ID, P.SkipReason.ALREADY_CONFIRMED);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID2, START);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ProtectionReleased(ID2);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptSkipped(ID2, P.SkipReason.STALE);
        policy.confirmReceipts(receipts);

        assertEq(token.balanceOf(RECIPIENT), NET);
        _assertNothingStranded();
    }

    function test_EmptyBatchDoesNothing() public {
        vm.recordLogs();
        policy.confirmReceipts(new IReceiptVerifier.ReceiptAttestation[](0));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    /* ============ Invalid receipts revert the batch ============ */

    function test_InvalidSignatureRevertsTheWholeBatch() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, START);
        receipts[1] = _receipt(ID2, START, METHOD, _nullifier(ID2), IMPOSTOR_KEY);

        vm.expectRevert(bytes(NOT_ENOUGH_SIGNATURES));
        policy.confirmReceipts(receipts);
        assertTrue(_isOpen(ID));
        assertEq(_releaseAt(ID), 0);
        assertEq(token.balanceOf(RECIPIENT), 0);
    }

    function test_WrongMethodRevertsTheWholeBatch() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, START + 1 days);
        receipts[1] = _receipt(ID2, START + 1 days, keccak256("wise"), _nullifier(ID2), WITNESS_KEY);

        vm.expectRevert(IReceiptVerifier.InvalidAttestation.selector);
        policy.confirmReceipts(receipts);
        assertEq(_releaseAt(ID), 0);
    }

    function test_UnboundPaymentRevertsTheWholeBatch() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = new IReceiptVerifier.ReceiptAttestation[](2);
        receipts[0] = _receipt(ID, START + 1 days);
        receipts[1] = _receipt(ID2, START + 1 days, METHOD, _nullifier(ID), WITNESS_KEY);

        vm.expectRevert(abi.encodeWithSelector(IReceiptVerifier.InvalidPaymentBinding.selector, ID2, _nullifier(ID)));
        policy.confirmReceipts(receipts);
        assertEq(_releaseAt(ID), 0);
    }

    /// @dev The signature binds the intent, so a receipt cannot be moved onto another protection.
    function test_ReceiptCannotBeReplayedOntoAnotherIntent() public {
        _settleDeferred(ID, RECIPIENT);
        _settleDeferred(ID2, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(ID, START);
        receipt.intentHash = ID2;

        vm.expectRevert(bytes(NOT_ENOUGH_SIGNATURES));
        policy.confirmReceipts(_batch(receipt));
    }

    /* ============ Disputes and early release ============ */

    /// @dev A share dispute after a confirmed future releaseAt pays the maker's share, clears the releaseAt and
    /// relocks the remainder until maturity, so the confirmation no longer releases it early.
    function test_ShareDisputeAfterConfirmedReleaseAtClearsIt() public {
        _settleDeferred(ID, RECIPIENT);
        policy.confirmReceipts(_batch(_receipt(ID, START + 3 days)));
        vm.warp(START + 3 days - 1);

        IDisputeVerifier.DisputeAttestation memory dispute = _dispute(ID, 24e6);
        vm.expectEmit(true, true, true, true, address(policy));
        emit DisputeResolved(ID, RECIPIENT, DEPOSITOR, 23_772_000, keccak256(abi.encode("dispute", ID)));
        vm.expectEmit(true, true, false, true, address(policy));
        emit RemainderRelocked(ID, RECIPIENT, NET - 23_772_000, MATURES_AT);
        policy.submitDispute(dispute);

        assertEq(vault.claimable(DEPOSITOR), 23_772_000);
        assertEq(token.balanceOf(RECIPIENT), 0);
        assertEq(_releaseAt(ID), 0);
        assertTrue(policy.getProtection(ID).partiallyDisputed);

        vm.warp(START + 3 days);
        vm.expectRevert(abi.encodeWithSelector(P.NotMatured.selector, MATURES_AT, START + 3 days));
        policy.release(_ids(ID));

        vm.warp(MATURES_AT);
        policy.release(_ids(ID));
        assertEq(token.balanceOf(RECIPIENT), NET - 23_772_000);
        assertFalse(_isOpen(ID));
        _assertNothingStranded();
    }

    /// @dev After a share dispute, a fresh receipt can confirm the relocked remainder like any open protection.
    function test_ReceiptAfterShareDisputeReleasesTheRemainderEarly() public {
        _settleStaked(ID);
        policy.submitDispute(_dispute(ID, 24e6));
        IReceiptVerifier.ReceiptAttestation[] memory receipts = _batch(_receipt(ID, START + 2 days));
        policy.confirmReceipts(receipts);
        assertEq(_releaseAt(ID), START + 2 days);

        vm.warp(START + 2 days);
        policy.release(_ids(ID));
        assertEq(vault.freeStake(TAKER), GROSS - 24e6);
        assertEq(vault.claimable(DEPOSITOR), 24e6);
        assertFalse(_isOpen(ID));
    }

    /// @dev Review focus: one recipient the vault cannot pay never sinks a keeper's batch. Its releaseAt is kept and
    /// `ReceiptPayoutFailed` emitted; `release` still reverts for it, as on V2, and a full dispute still works.
    function test_DueReceiptWithFailingPayoutDoesNotSinkTheBatch() public {
        BlacklistTokenMock blacklistToken = new BlacklistTokenMock();
        _deploy(blacklistToken);
        address blocked = address(0xB10C);
        _settleDeferred(ID, blocked);
        _settleDeferred(ID2, RECIPIENT);
        _settleDeferred(ID3, RECIPIENT);
        blacklistToken.setBlacklisted(blocked, true);
        IReceiptVerifier.ReceiptAttestation[] memory receipts =
            _batch(_receipt(ID, START), _receipt(ID2, START), _receipt(ID3, START + 1 days));

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID, START);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptPayoutFailed(ID);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID2, START);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ProtectionReleased(ID2);
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptConfirmed(ID3, START + 1 days);
        policy.confirmReceipts(receipts);

        P.Protection memory failed = policy.getProtection(ID);
        assertEq(failed.depositor, DEPOSITOR);
        assertTrue(failed.deferredPayout);
        assertEq(failed.paymentMethod, METHOD);
        assertEq(failed.releaseAt, START);
        assertEq(failed.releaseAmount, GROSS);
        (address lockOwner, uint256 lockAmount,) = vault.locks(ID);
        assertEq(lockOwner, blocked);
        assertEq(lockAmount, NET);
        assertEq(blacklistToken.balanceOf(RECIPIENT), NET);
        assertFalse(_isOpen(ID2));
        assertEq(_releaseAt(ID3), START + 1 days);

        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        policy.release(_ids(ID));
        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptSkipped(ID, P.SkipReason.ALREADY_CONFIRMED);
        policy.confirmReceipts(_batch(_receipt(ID, START)));

        policy.submitDispute(_dispute(ID, GROSS));
        assertEq(vault.claimable(DEPOSITOR), NET);
        assertFalse(_isOpen(ID));
        _assertNothingStranded();
    }

    /// @dev A failed stake unlock (the policy lost its vault controller role) is likewise kept, not fatal.
    function test_DueReceiptWithFailingStakeUnlockKeepsTheProtection() public {
        _settleStaked(ID);
        IReceiptVerifier.ReceiptAttestation[] memory receipts = _batch(_receipt(ID, START));
        vault.setController(address(policy), false);

        vm.expectEmit(true, false, false, true, address(policy));
        emit ReceiptPayoutFailed(ID);
        policy.confirmReceipts(receipts);
        assertEq(_releaseAt(ID), START);
        assertEq(vault.lockedStake(TAKER), GROSS);

        vault.setController(address(policy), true);
        policy.release(_ids(ID));
        assertEq(vault.freeStake(TAKER), GROSS);
    }

    /// @dev A dispute stays possible after releaseAt until the protection is paid out.
    function test_DisputeAfterReleaseAtBeforePayoutSucceeds() public {
        _settleStaked(ID);
        policy.confirmReceipts(_batch(_receipt(ID, START + 1 days)));
        vm.warp(START + 2 days);

        policy.submitDispute(_dispute(ID, GROSS));
        assertEq(vault.claimable(DEPOSITOR), GROSS);
        assertFalse(_isOpen(ID));
    }

    /// @dev The recipient re-enters through a token hook while confirmReceipts pays it out; every attempt fails.
    function test_ReentrantPayoutDuringConfirmationFails() public {
        PayoutHookTokenMock hookToken = new PayoutHookTokenMock();
        _deploy(hookToken);
        ReentrantPayoutRecipientMock recipient = new ReentrantPayoutRecipientMock();
        _settleDeferred(ID, address(recipient));
        _settleDeferred(ID2, address(recipient));
        IReceiptVerifier.ReceiptAttestation[] memory receipts = _batch(_receipt(ID, START));
        bytes[] memory payloads = new bytes[](3);
        payloads[0] = abi.encodeCall(DisputeProtectionPolicyV3.confirmReceipts, (_batch(_receipt(ID2, START))));
        payloads[1] = abi.encodeCall(DisputeProtectionPolicyV3.submitDispute, (_dispute(ID2, GROSS)));
        payloads[2] = abi.encodeCall(DisputeProtectionPolicyV3.confirmReceipts, (receipts));
        recipient.arm(address(policy), payloads);
        hookToken.setHookTarget(address(recipient));

        policy.confirmReceipts(receipts);

        assertEq(recipient.hookCalls(), 1);
        assertEq(recipient.reentrySuccesses(), 0);
        assertEq(recipient.failureCount(), 3);
        for (uint256 index; index < 3; ++index) {
            assertEq(recipient.failure(index), abi.encodeWithSignature("Error(string)", REENTRANT_CALL));
        }
        assertEq(hookToken.balanceOf(address(recipient)), NET);
        assertTrue(_isOpen(ID2));
        assertEq(_releaseAt(ID2), 0);
        _assertNothingStranded();
    }

    /* ============ Governance ============ */

    function test_SetReceiptVerifierIsOwnerOnlyAndEmits() public {
        ReceiptVerifier next = new ReceiptVerifier(address(this), payments, witnesses);
        vm.prank(STRANGER);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        policy.setReceiptVerifier(address(next));

        vm.expectEmit(true, true, false, true, address(policy));
        emit ReceiptVerifierUpdated(address(receiptVerifier), address(next));
        policy.setReceiptVerifier(address(next));
        assertEq(address(policy.receiptVerifier()), address(next));

        _settleDeferred(ID, RECIPIENT);
        IReceiptVerifier.ReceiptAttestation memory receipt = _receipt(ID, START + 1 days);
        vm.expectRevert(bytes(NOT_ENOUGH_SIGNATURES));
        policy.confirmReceipts(_batch(receipt));
    }

    /* ============ Gas ============ */

    /// @dev 50 deferred holds confirmed in one call with real witness signatures and nullifier lookups, from cold
    /// storage. Logs the execution gas of the call and the calldata gas a transaction would add.
    function test_GasFiftyReceiptBatch() public {
        uint256 count = 50;
        IReceiptVerifier.ReceiptAttestation[] memory held = new IReceiptVerifier.ReceiptAttestation[](count);
        IReceiptVerifier.ReceiptAttestation[] memory due = new IReceiptVerifier.ReceiptAttestation[](count);
        for (uint256 index; index < count; ++index) {
            bytes32 heldId = keccak256(abi.encode("held", index));
            bytes32 dueId = keccak256(abi.encode("due", index));
            _settleDeferred(heldId, address(uint160(0x1000 + index)));
            _settleDeferred(dueId, address(uint160(0x2000 + index)));
            held[index] = _receipt(heldId, START + 7 days);
            due[index] = _receipt(dueId, START);
        }

        uint256 heldGas = _measure(held);
        uint256 dueGas = _measure(due);
        emit log_named_uint("confirmReceipts x50, releaseAt in future (store), execution gas", heldGas);
        emit log_named_uint("confirmReceipts x50, releaseAt passed (pay out), execution gas", dueGas);
        emit log_named_uint("confirmReceipts x50, calldata gas", _calldataGas(abi.encodeCall(policy.confirmReceipts, (held))));

        for (uint256 index; index < count; ++index) {
            assertEq(_releaseAt(held[index].intentHash), START + 7 days);
            assertFalse(_isOpen(due[index].intentHash));
            assertEq(token.balanceOf(address(uint160(0x2000 + index))), NET);
        }
    }

    function _measure(IReceiptVerifier.ReceiptAttestation[] memory receipts) internal returns (uint256 gasUsed) {
        address[7] memory touched = [
            address(policy), address(vault), address(receiptVerifier), address(witnesses), address(payments),
            address(predecessor), address(token)
        ];
        for (uint256 index; index < touched.length; ++index) vm.cool(touched[index]);
        uint256 gasBefore = gasleft();
        policy.confirmReceipts(receipts);
        gasUsed = gasBefore - gasleft();
    }

    function _calldataGas(bytes memory callData) internal pure returns (uint256 gas) {
        for (uint256 index; index < callData.length; ++index) gas += callData[index] == 0 ? 4 : 16;
    }
}
